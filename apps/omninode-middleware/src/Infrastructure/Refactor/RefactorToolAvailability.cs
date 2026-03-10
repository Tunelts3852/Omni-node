namespace OmniNode.Middleware;

public sealed record RefactorToolProbe(
    string Tool,
    bool Enabled,
    bool Available,
    string Status,
    string Message,
    string? BinaryPath = null,
    string? Language = null
);

public sealed class RefactorToolAvailability
{
    public RefactorToolProbe ProbeLsp(string path, bool enabled)
    {
        var language = ResolveLanguage(path);
        if (!enabled)
        {
            return new RefactorToolProbe("lsp", false, false, "disabled", "OMNINODE_REFACTOR_ENABLE_LSP=1 이어야 합니다.", Language: language);
        }

        if (string.IsNullOrWhiteSpace(language))
        {
            return new RefactorToolProbe("lsp", true, false, "unsupported_language", "이 파일 확장자는 현재 LSP probe 대상이 아닙니다.");
        }

        var binary = FindExecutable(GetLspCandidates(language));
        if (string.IsNullOrWhiteSpace(binary))
        {
            var npmFallback = ResolveLspNpmFallback(language);
            if (!string.IsNullOrWhiteSpace(npmFallback) && !string.IsNullOrWhiteSpace(FindExecutable(new[] { "npm" })))
            {
                return new RefactorToolProbe(
                    "lsp",
                    true,
                    true,
                    "available",
                    "LSP 서버는 npm exec fallback으로 실행합니다.",
                    npmFallback,
                    language
                );
            }

            return new RefactorToolProbe("lsp", true, false, "missing_binary", "언어별 LSP 서버 바이너리를 찾지 못했습니다.", Language: language);
        }

        return new RefactorToolProbe("lsp", true, true, "available", "LSP 서버 바이너리를 감지했습니다.", binary, language);
    }

    public RefactorToolProbe ProbeAstGrep(string path, bool enabled)
    {
        var language = ResolveLanguage(path);
        if (!enabled)
        {
            return new RefactorToolProbe("ast-grep", false, false, "disabled", "OMNINODE_REFACTOR_ENABLE_AST_GREP=1 이어야 합니다.", Language: language);
        }

        if (string.IsNullOrWhiteSpace(language))
        {
            return new RefactorToolProbe("ast-grep", true, false, "unsupported_language", "이 파일 확장자는 현재 ast-grep probe 대상이 아닙니다.");
        }

        var binary = FindExecutable(new[] { "ast-grep", "sg" });
        if (string.IsNullOrWhiteSpace(binary))
        {
            if (!string.IsNullOrWhiteSpace(FindExecutable(new[] { "npm" })))
            {
                return new RefactorToolProbe(
                    "ast-grep",
                    true,
                    true,
                    "available",
                    "ast-grep는 npm exec fallback으로 실행합니다.",
                    "npm:@ast-grep/cli",
                    language
                );
            }

            return new RefactorToolProbe("ast-grep", true, false, "missing_binary", "ast-grep 바이너리를 찾지 못했습니다.", Language: language);
        }

        return new RefactorToolProbe("ast-grep", true, true, "available", "ast-grep 바이너리를 감지했습니다.", binary, language);
    }

    internal static string? ResolveLanguage(string path)
    {
        var extension = Path.GetExtension(path ?? string.Empty).Trim().ToLowerInvariant();
        return extension switch
        {
            ".js" or ".jsx" or ".ts" or ".tsx" => "typescript",
            ".py" => "python",
            ".cs" => "csharp",
            ".c" or ".h" or ".cc" or ".cpp" or ".hpp" => "cpp",
            ".go" => "go",
            ".rs" => "rust",
            ".java" => "java",
            ".json" => "json",
            ".html" or ".css" => "web",
            _ => null
        };
    }

    private static string? ResolveLspNpmFallback(string language)
    {
        return language switch
        {
            "typescript" => "npm:typescript-language-server",
            "python" => "npm:pyright-langserver",
            _ => null
        };
    }

    private static IReadOnlyList<string> GetLspCandidates(string language)
    {
        return language switch
        {
            "typescript" => new[] { "typescript-language-server" },
            "python" => new[] { "pylsp", "pyright-langserver" },
            "csharp" => new[] { "csharp-ls", "omnisharp" },
            "cpp" => new[] { "clangd" },
            "go" => new[] { "gopls" },
            "rust" => new[] { "rust-analyzer" },
            "java" => new[] { "jdtls" },
            _ => Array.Empty<string>()
        };
    }

    internal static string? FindExecutable(IReadOnlyList<string> candidates)
    {
        if (candidates.Count == 0)
        {
            return null;
        }

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        var folders = pathValue
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var executableExtensions = OperatingSystem.IsWindows()
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT")
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : new[] { string.Empty };

        foreach (var candidate in candidates)
        {
            if (Path.IsPathRooted(candidate) && File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }

            foreach (var folder in folders)
            {
                foreach (var extension in executableExtensions)
                {
                    var combined = Path.Combine(folder, $"{candidate}{extension.ToLowerInvariant()}");
                    if (File.Exists(combined))
                    {
                        return combined;
                    }
                }
            }
        }

        return null;
    }
}
