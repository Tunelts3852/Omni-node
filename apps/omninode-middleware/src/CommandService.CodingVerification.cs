using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private static string WrapCommandWithExpectedOutputAssertion(
        string command,
        string? expectedOutput,
        IReadOnlyList<string>? expectedOutputLines = null
    )
    {
        var normalizedCommand = NormalizeGeneratedRunCommand(command);
        var resolvedExpectedLines = ResolveExpectedOutputAssertionLines(expectedOutput, expectedOutputLines);
        if (string.IsNullOrWhiteSpace(normalizedCommand) || resolvedExpectedLines.Count == 0)
        {
            return normalizedCommand;
        }

        var builder = new StringBuilder();
        builder.Append("tmp_out=$(mktemp); tmp_err=$(mktemp); __omni_status=0; ");
        builder.Append($"({normalizedCommand}) >\"$tmp_out\" 2>\"$tmp_err\" || __omni_status=$?; ");
        builder.Append("cat \"$tmp_out\"; cat \"$tmp_err\" >&2; ");
        builder.Append("if [ $__omni_status -ne 0 ]; then rm -f \"$tmp_out\" \"$tmp_err\"; exit $__omni_status; fi; ");
        AppendExpectedOutputAssertions(builder, resolvedExpectedLines);
        builder.Append("rm -f \"$tmp_out\" \"$tmp_err\"");
        return builder.ToString();
    }

    private static string WrapCommandWithVerificationAssertions(
        string command,
        string? expectedOutput,
        IReadOnlyCollection<string> verifiedFiles,
        IReadOnlyList<string>? expectedOutputLines = null
    )
    {
        var normalizedCommand = NormalizeGeneratedRunCommand(command);
        var resolvedExpectedLines = ResolveExpectedOutputAssertionLines(expectedOutput, expectedOutputLines);
        var files = (verifiedFiles ?? Array.Empty<string>())
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (string.IsNullOrWhiteSpace(normalizedCommand))
        {
            return normalizedCommand;
        }

        if (files.Length == 0 && resolvedExpectedLines.Count == 0)
        {
            return normalizedCommand;
        }

        var builder = new StringBuilder();
        builder.Append("tmp_out=$(mktemp); tmp_err=$(mktemp); __omni_status=0; ");
        builder.Append($"({normalizedCommand}) >\"$tmp_out\" 2>\"$tmp_err\" || __omni_status=$?; ");
        builder.Append("cat \"$tmp_out\"; cat \"$tmp_err\" >&2; ");
        builder.Append("if [ $__omni_status -ne 0 ]; then rm -f \"$tmp_out\" \"$tmp_err\"; exit $__omni_status; fi; ");
        foreach (var path in files)
        {
            var safePath = EscapeShellArg(path);
            var failureMessageArg = EscapeShellArg($"verified file missing: {path}");
            builder.Append($"if [ ! -f {safePath} ]; then printf '%s\\n' {failureMessageArg} >&2; rm -f \"$tmp_out\" \"$tmp_err\"; exit 1; fi; ");
        }

        AppendExpectedOutputAssertions(builder, resolvedExpectedLines);

        builder.Append("rm -f \"$tmp_out\" \"$tmp_err\"");
        return builder.ToString();
    }

    private static string DescribeCommandWithExpectedOutput(
        string command,
        string? expectedOutput,
        IReadOnlyList<string>? expectedOutputLines = null
    )
    {
        var normalizedCommand = NormalizeGeneratedRunCommand(command);
        var resolvedExpectedLines = ResolveExpectedOutputAssertionLines(expectedOutput, expectedOutputLines);
        if (resolvedExpectedLines.Count == 0)
        {
            return normalizedCommand;
        }

        var compactExpected = string.Join(" | ", resolvedExpectedLines.Take(2));
        compactExpected = Regex.Replace(compactExpected.Trim(), @"\s+", " ");
        if (compactExpected.Length > 80)
        {
            compactExpected = compactExpected[..80] + "...";
        }

        return $"{normalizedCommand} [stdout 포함: {compactExpected}]";
    }

    private static string DescribeVerificationCommand(
        string command,
        string? expectedOutput,
        IReadOnlyCollection<string> verifiedFiles,
        IReadOnlyList<string>? expectedOutputLines = null
    )
    {
        var description = DescribeCommandWithExpectedOutput(command, expectedOutput, expectedOutputLines);
        var fileCount = (verifiedFiles ?? Array.Empty<string>())
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();
        return fileCount > 0 ? $"{description} [파일 확인: {fileCount}개]" : description;
    }

    private static string BuildVerificationCommand(
        string language,
        IReadOnlyCollection<string> changedFiles,
        string workspaceRoot,
        string objective,
        IReadOnlyList<string>? requestedPaths = null,
        string? expectedOutput = null
    )
    {
        var baseCommand = BuildVerificationBaseCommand(language, changedFiles, workspaceRoot, objective, requestedPaths, expectedOutput);
        var expectedOutputLines = ExtractExpectedConsoleOutputLines(objective);
        return WrapCommandWithVerificationAssertions(baseCommand, expectedOutput, changedFiles, expectedOutputLines);
    }

    private static string BuildVerificationDisplayCommand(
        string language,
        IReadOnlyCollection<string> changedFiles,
        string workspaceRoot,
        string objective,
        IReadOnlyList<string>? requestedPaths = null,
        string? expectedOutput = null
    )
    {
        var baseCommand = BuildVerificationBaseCommand(language, changedFiles, workspaceRoot, objective, requestedPaths, expectedOutput);
        var expectedOutputLines = ExtractExpectedConsoleOutputLines(objective);
        return DescribeVerificationCommand(baseCommand, expectedOutput, changedFiles, expectedOutputLines);
    }

    private static string BuildVerificationBaseCommand(
        string language,
        IReadOnlyCollection<string> changedFiles,
        string workspaceRoot,
        string objective,
        IReadOnlyList<string>? requestedPaths = null,
        string? expectedOutput = null
    )
    {
        var objectiveText = ExtractLatestCodingRequestText(WebUtility.HtmlDecode(objective ?? string.Empty));
        var normalizedLanguage = NormalizeLanguageForCode(language);
        var expectedOutputLines = ExtractExpectedConsoleOutputLines(objectiveText);
        var hasExpectedOutput = !string.IsNullOrWhiteSpace(expectedOutput) || expectedOutputLines.Count > 0;
        var shouldRunProgram = ShouldPreferProgramExecutionForVerification(
            objectiveText,
            normalizedLanguage,
            hasExpectedOutput ? (expectedOutput ?? string.Join("\n", expectedOutputLines)) : expectedOutput
        );
        var explicitCommand = TryBuildExplicitVerificationCommand(objectiveText, workspaceRoot, changedFiles);
        if (!string.IsNullOrWhiteSpace(explicitCommand))
        {
            return explicitCommand;
        }

        string? firstFile = null;
        if (shouldRunProgram)
        {
            firstFile = TrySelectExplicitExecutionTargetPath(objectiveText, workspaceRoot, changedFiles);
        }

        if (requestedPaths != null)
        {
            foreach (var requestedPath in requestedPaths)
            {
                if (string.IsNullOrWhiteSpace(requestedPath))
                {
                    continue;
                }

                var candidate = ResolveWorkspacePath(workspaceRoot, requestedPath);
                if (changedFiles.Contains(candidate, StringComparer.OrdinalIgnoreCase) && File.Exists(candidate))
                {
                    firstFile = candidate;
                    break;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(firstFile) && shouldRunProgram)
        {
            firstFile = SelectEntryLikeChangedFile(normalizedLanguage, changedFiles);
        }

        firstFile ??= changedFiles
            .FirstOrDefault(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        if (string.IsNullOrWhiteSpace(firstFile))
        {
            return string.Empty;
        }

        var safePath = EscapeShellArg(firstFile);
        var workspaceSafe = workspaceRoot.Replace("'", "'\"'\"'", StringComparison.Ordinal);
        if (normalizedLanguage == "python")
        {
            var sourceFiles = SelectChangedFilesByExtension(workspaceRoot, changedFiles, ".py");
            var sourceArgs = JoinShellArgs(sourceFiles.Length > 0 ? sourceFiles : new[] { ToWorkspaceRelativePath(workspaceRoot, firstFile) });
            if (hasExpectedOutput || shouldRunProgram)
            {
                return $"python3 {safePath}";
            }

            if (ShouldRequireDependencyFreePythonGame(objectiveText, normalizedLanguage))
            {
                var pythonFiles = sourceFiles.Length > 0
                    ? sourceFiles.Select(path => ResolveWorkspacePath(workspaceRoot, path)).Where(File.Exists).ToArray()
                    : new[] { firstFile };
                var externalPackages = CollectPythonThirdPartyPackagesFromSources(pythonFiles);
                if (externalPackages.Count > 0)
                {
                    var message = $"interactive python game must avoid third-party packages: {string.Join(", ", externalPackages)}";
                    return $"printf '%s\\n' {EscapeShellArg(message)} >&2; exit 1";
                }

                if (!LooksLikeInteractivePythonGameSource(pythonFiles))
                {
                    var message = "interactive python game must include real input/render loop; print-only simulation is insufficient";
                    return $"printf '%s\\n' {EscapeShellArg(message)} >&2; exit 1";
                }

                var interactiveModules = CollectInteractivePythonModulesFromSources(pythonFiles);
                if (interactiveModules.Count > 0)
                {
                    return $"cd '{workspaceSafe}' && python3 -m py_compile {sourceArgs} && {BuildInteractivePythonModuleAvailabilityCommand(interactiveModules)}";
                }
            }

            return $"cd '{workspaceSafe}' && python3 -m py_compile {sourceArgs}";
        }

        if (normalizedLanguage == "javascript")
        {
            if (hasExpectedOutput || shouldRunProgram)
            {
                return $"if command -v node >/dev/null 2>&1; then node {safePath}; else echo 'node 없음'; exit 1; fi";
            }

            return $"if command -v node >/dev/null 2>&1; then node --check {safePath}; else echo 'node 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "c")
        {
            var sourceFiles = SelectChangedFilesByExtension(workspaceRoot, changedFiles, ".c");
            var sourceArgs = JoinShellArgs(sourceFiles.Length > 0 ? sourceFiles : new[] { ToWorkspaceRelativePath(workspaceRoot, firstFile) });
            if (hasExpectedOutput || shouldRunProgram)
            {
                return $"cd '{workspaceSafe}' && if command -v cc >/dev/null 2>&1; then cc -std=c11 -O2 {sourceArgs} -o app && ./app; else echo 'cc 없음'; exit 1; fi";
            }

            return $"cd '{workspaceSafe}' && if command -v cc >/dev/null 2>&1; then cc -std=c11 -fsyntax-only {sourceArgs}; else echo 'cc 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "cpp")
        {
            return $"if command -v c++ >/dev/null 2>&1; then c++ -fsyntax-only {safePath}; elif command -v g++ >/dev/null 2>&1; then g++ -fsyntax-only {safePath}; else echo 'c++ 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "csharp")
        {
            return "if command -v dotnet >/dev/null 2>&1; then dotnet --info >/dev/null; echo 'dotnet 확인 완료'; else echo 'dotnet 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "java")
        {
            var sourceFiles = SelectChangedFilesByExtension(workspaceRoot, changedFiles, ".java");
            var sourceArgs = JoinShellArgs(sourceFiles.Length > 0 ? sourceFiles : new[] { ToWorkspaceRelativePath(workspaceRoot, firstFile) });
            var mainClass = EscapeShellArg(Path.GetFileNameWithoutExtension(firstFile));
            if (hasExpectedOutput || shouldRunProgram)
            {
                return $"cd '{workspaceSafe}' && if command -v javac >/dev/null 2>&1; then javac -Xlint:none {sourceArgs} && java {mainClass}; else echo 'javac 없음'; exit 1; fi";
            }

            return $"cd '{workspaceSafe}' && if command -v javac >/dev/null 2>&1; then javac -Xlint:none {sourceArgs}; else echo 'javac 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "kotlin")
        {
            return "if command -v kotlinc >/dev/null 2>&1; then echo 'kotlinc 확인 완료'; else echo 'kotlinc 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "html" || normalizedLanguage == "css")
        {
            var structuredHtmlCommand = TryBuildStructuredHtmlVerificationCommand(workspaceRoot, objectiveText, changedFiles, requestedPaths);
            if (!string.IsNullOrWhiteSpace(structuredHtmlCommand))
            {
                return structuredHtmlCommand;
            }

            return $"test -f {safePath} && echo '정적 파일 생성 확인: {Path.GetFileName(firstFile)}'";
        }

        if (normalizedLanguage == "bash")
        {
            if (hasExpectedOutput || shouldRunProgram)
            {
                return $"if command -v bash >/dev/null 2>&1; then bash {safePath}; else echo 'bash 없음'; exit 1; fi";
            }

            return $"if command -v bash >/dev/null 2>&1; then bash -n {safePath}; else echo 'bash 없음, 파일 생성 확인'; fi";
        }

        return $"cd '{workspaceSafe}' && ls -la";
    }

    private static IReadOnlyList<string> ResolveExpectedOutputAssertionLines(
        string? expectedOutput,
        IReadOnlyList<string>? expectedOutputLines
    )
    {
        if (expectedOutputLines != null && expectedOutputLines.Count > 0)
        {
            return expectedOutputLines
                .Where(line => !string.IsNullOrWhiteSpace(line))
                .Select(line => line.Trim())
                .ToArray();
        }

        var trimmed = expectedOutput?.Trim() ?? string.Empty;
        return string.IsNullOrWhiteSpace(trimmed) ? Array.Empty<string>() : new[] { trimmed };
    }

    private static void AppendExpectedOutputAssertions(StringBuilder builder, IReadOnlyList<string> expectedLines)
    {
        if (builder == null || expectedLines == null || expectedLines.Count == 0)
        {
            return;
        }

        builder.Append("__omni_line_count=$(awk 'NF{count++} END{print count+0}' \"$tmp_out\"); ");
        builder.Append($"if [ \"$__omni_line_count\" -lt {expectedLines.Count} ]; then printf '%s\\n' {EscapeShellArg($"expected at least {expectedLines.Count} stdout lines")} >&2; rm -f \"$tmp_out\" \"$tmp_err\"; exit 1; fi; ");

        for (var index = 0; index < expectedLines.Count; index++)
        {
            var expectedLine = expectedLines[index].Trim();
            if (string.IsNullOrWhiteSpace(expectedLine))
            {
                continue;
            }

            var lineArg = EscapeShellArg(expectedLine);
            var failureMessageArg = EscapeShellArg($"expected line {index + 1} mismatch: {expectedLine}");
            builder.Append($"if [ \"$(awk 'NF{{seen++; if (seen=={index + 1}) {{ print; exit }} }}' \"$tmp_out\")\" != {lineArg} ]; then printf '%s\\n' {failureMessageArg} >&2; rm -f \"$tmp_out\" \"$tmp_err\"; exit 1; fi; ");
        }
    }

    private static string TryBuildStructuredHtmlVerificationCommand(
        string workspaceRoot,
        string objectiveText,
        IReadOnlyCollection<string> changedFiles,
        IReadOnlyList<string>? requestedPaths
    )
    {
        var indexPath = TryResolveStructuredRelativePath(workspaceRoot, changedFiles, requestedPaths, "index.html");
        var cssPath = TryResolveStructuredRelativePath(workspaceRoot, changedFiles, requestedPaths, "styles.css");
        var scriptPath = TryResolveStructuredRelativePath(workspaceRoot, changedFiles, requestedPaths, "app.js");
        if (string.IsNullOrWhiteSpace(indexPath) || string.IsNullOrWhiteSpace(cssPath) || string.IsNullOrWhiteSpace(scriptPath))
        {
            return string.Empty;
        }

        var workspaceSafe = workspaceRoot.Replace("'", "'\"'\"'", StringComparison.Ordinal);
        var commands = new List<string>
        {
            $"cd '{workspaceSafe}'",
            $"ls -1 {EscapeShellArg(indexPath)} {EscapeShellArg(cssPath)} {EscapeShellArg(scriptPath)}",
            $"__omni_first_html=$(awk 'NF{{print tolower($0); exit}}' {EscapeShellArg(indexPath)}); case \"$__omni_first_html\" in '<!doctype html>'*|'<html'*) : ;; *) echo 'index.html must start with html' >&2; exit 1 ;; esac",
            $"! grep -Fq -- '#!/usr/bin/env bash' {EscapeShellArg(indexPath)} {EscapeShellArg(cssPath)} {EscapeShellArg(scriptPath)}",
            $"! grep -Fq -- 'cat > ' {EscapeShellArg(indexPath)} {EscapeShellArg(cssPath)} {EscapeShellArg(scriptPath)}",
            $"grep -Fq -- 'dashboard-root' {EscapeShellArg(indexPath)}",
            $"if command -v node >/dev/null 2>&1; then node --check {EscapeShellArg(scriptPath)}; else echo 'node 없음'; exit 1; fi"
        };

        if (objectiveText.Contains("bucket-card", StringComparison.OrdinalIgnoreCase))
        {
            commands.Add($"grep -Fq -- 'bucket-card' {EscapeShellArg(scriptPath)}");
        }

        if (objectiveText.Contains("border-radius: 16px", StringComparison.OrdinalIgnoreCase))
        {
            commands.Add($"grep -Fq -- 'border-radius: 16px' {EscapeShellArg(cssPath)}");
        }

        if (objectiveText.Contains("domcontentloaded", StringComparison.OrdinalIgnoreCase)
            || objectiveText.Contains("document.addeventlistener", StringComparison.OrdinalIgnoreCase))
        {
            commands.Add($"grep -Fq -- 'DOMContentLoaded' {EscapeShellArg(scriptPath)}");
        }

        return string.Join(" && ", commands);
    }

    private static string TryResolveStructuredRelativePath(
        string workspaceRoot,
        IReadOnlyCollection<string> changedFiles,
        IReadOnlyList<string>? requestedPaths,
        string targetFileName
    )
    {
        if (requestedPaths != null)
        {
            var requested = requestedPaths.FirstOrDefault(path =>
                !string.IsNullOrWhiteSpace(path)
                && string.Equals(Path.GetFileName(path), targetFileName, StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(requested))
            {
                return requested.Replace('\\', '/');
            }
        }

        var changed = changedFiles.FirstOrDefault(path =>
            !string.IsNullOrWhiteSpace(path)
            && File.Exists(path)
            && string.Equals(Path.GetFileName(path), targetFileName, StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrWhiteSpace(changed))
        {
            return string.Empty;
        }

        return ToWorkspaceRelativePath(workspaceRoot, changed);
    }

    private static string[] SelectChangedFilesByExtension(string workspaceRoot, IReadOnlyCollection<string> changedFiles, params string[] extensions)
    {
        if (changedFiles == null || changedFiles.Count == 0 || extensions == null || extensions.Length == 0)
        {
            return Array.Empty<string>();
        }

        var normalizedExtensions = new HashSet<string>(
            extensions
                .Where(extension => !string.IsNullOrWhiteSpace(extension))
                .Select(extension => extension.StartsWith(".", StringComparison.Ordinal) ? extension.ToLowerInvariant() : "." + extension.ToLowerInvariant()),
            StringComparer.OrdinalIgnoreCase
        );

        return changedFiles
            .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
            .Where(path => normalizedExtensions.Contains(Path.GetExtension(path)))
            .Select(path => ToWorkspaceRelativePath(workspaceRoot, path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IReadOnlyList<string> CollectPythonThirdPartyPackagesFromSources(IEnumerable<string> sourceFiles)
    {
        var packages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sourceFile in sourceFiles ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(sourceFile) || !File.Exists(sourceFile))
            {
                continue;
            }

            foreach (var package in ExtractPythonPackagesFromSource(sourceFile))
            {
                if (!string.IsNullOrWhiteSpace(package))
                {
                    packages.Add(package);
                }
            }
        }

        return packages.OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static bool LooksLikeInteractivePythonGameSource(IEnumerable<string> sourceFiles)
    {
        foreach (var sourceFile in sourceFiles ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(sourceFile) || !File.Exists(sourceFile))
            {
                continue;
            }

            string text;
            try
            {
                text = File.ReadAllText(sourceFile);
            }
            catch
            {
                continue;
            }

            if (Regex.IsMatch(text, @"\bimport\s+(tkinter|curses|turtle)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bfrom\s+(tkinter|curses|turtle)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bmainloop\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bgetch\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bnodelay\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bCanvas\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\bScreen\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                || Regex.IsMatch(text, @"\b(onkey|bind|bind_all)\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                return true;
            }
        }

        return false;
    }

    private static IReadOnlyList<string> CollectInteractivePythonModulesFromSources(IEnumerable<string> sourceFiles)
    {
        var modules = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sourceFile in sourceFiles ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(sourceFile) || !File.Exists(sourceFile))
            {
                continue;
            }

            string text;
            try
            {
                text = File.ReadAllText(sourceFile);
            }
            catch
            {
                continue;
            }

            if (Regex.IsMatch(text, @"\bimport\s+tkinter\b|\bfrom\s+tkinter\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                modules.Add("tkinter");
            }

            if (Regex.IsMatch(text, @"\bimport\s+curses\b|\bfrom\s+curses\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                modules.Add("curses");
            }

            if (Regex.IsMatch(text, @"\bimport\s+turtle\b|\bfrom\s+turtle\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                modules.Add("turtle");
            }
        }

        return modules.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string BuildInteractivePythonModuleAvailabilityCommand(IEnumerable<string> moduleNames)
    {
        var modules = (moduleNames ?? Array.Empty<string>())
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (modules.Length == 0)
        {
            return "python3 -c 'import sys; sys.exit(0)'";
        }

        const string script = "import importlib, sys; missing = []; exec(\"for mod in sys.argv[1:]:\\n    try:\\n        importlib.import_module(mod)\\n    except Exception as ex:\\n        missing.append(f\\\"{mod}: {ex.__class__.__name__}: {ex}\\\")\"); missing and print(\"interactive python game unavailable modules: \" + \" | \".join(missing), file=sys.stderr); sys.exit(1 if missing else 0)";
        return $"python3 -c {EscapeShellArg(script)} {JoinShellArgs(modules)}";
    }

    private static string ToWorkspaceRelativePath(string workspaceRoot, string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        try
        {
            var relative = Path.GetRelativePath(workspaceRoot, path).Replace('\\', '/');
            return string.IsNullOrWhiteSpace(relative) ? Path.GetFileName(path) : relative;
        }
        catch
        {
            return Path.GetFileName(path);
        }
    }

    private static string JoinShellArgs(IEnumerable<string> values)
    {
        return string.Join(
            " ",
            (values ?? Array.Empty<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(EscapeShellArg)
        );
    }
}
