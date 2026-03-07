using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace OmniNode.Middleware;

public sealed record AcpSessionBindingDispatchRequest(
    string RunId,
    string ChildSessionKey,
    string Mode,
    string Task,
    int RunTimeoutSeconds,
    bool Thread,
    string? Model,
    string? Thinking,
    bool? LightContext
);

public sealed record AcpSessionBindingDispatchResult(
    bool Accepted,
    string Status,
    string Backend,
    string DispatchMode,
    string Message,
    string? Error = null,
    string? BackendSessionId = null,
    string? ThreadBindingKey = null,
    string? RawOutput = null
);

public sealed class AcpSessionBindingAdapter
{
    private const int DefaultAdapterTimeoutMs = 15_000;
    private const int MaxAdapterTimeoutMs = 300_000;
    private const string BundledCodexAdapterRelativePath = "omninode-middleware/tools/acp-adapter-codex-exec.js";
    private readonly string _workspaceRoot;
    private readonly string _codexBinaryPath;
    private readonly RuntimeSettings _runtimeSettings;
    private readonly string _configuredMode;
    private readonly string? _configuredCommand;

    public AcpSessionBindingAdapter(string workspaceRoot, string? codexBinaryPath, RuntimeSettings runtimeSettings)
    {
        _workspaceRoot = string.IsNullOrWhiteSpace(workspaceRoot)
            ? Directory.GetCurrentDirectory()
            : workspaceRoot;
        _codexBinaryPath = string.IsNullOrWhiteSpace(codexBinaryPath) ? "codex" : codexBinaryPath.Trim();
        _runtimeSettings = runtimeSettings;
        _configuredMode = NormalizeMode(Environment.GetEnvironmentVariable("OMNINODE_ACP_ADAPTER_MODE"));
        var configuredCommand = (Environment.GetEnvironmentVariable("OMNINODE_ACP_ADAPTER_COMMAND") ?? string.Empty).Trim();
        _configuredCommand = string.IsNullOrWhiteSpace(configuredCommand)
            ? ResolveBundledAdapterCommand(_workspaceRoot)
            : configuredCommand;
    }

    public AcpSessionBindingDispatchResult Dispatch(AcpSessionBindingDispatchRequest request)
    {
        var dispatchMode = ResolveDispatchMode(_configuredMode, _configuredCommand);
        return dispatchMode switch
        {
            "fake" => DispatchFake(request),
            "command" => DispatchCommand(request),
            _ => DispatchStaged(request)
        };
    }

    private AcpSessionBindingDispatchResult DispatchStaged(AcpSessionBindingDispatchRequest request)
    {
        var optionSummary = BuildOptionSummary(request);
        return new AcpSessionBindingDispatchResult(
            Accepted: true,
            Status: "accepted",
            Backend: "staged",
            DispatchMode: "staged",
            Message: $"staged ACP dispatch accepted ({optionSummary})"
        );
    }

    private AcpSessionBindingDispatchResult DispatchFake(AcpSessionBindingDispatchRequest request)
    {
        var backendSessionId = $"fake-{request.RunId[..Math.Min(12, request.RunId.Length)]}";
        var optionSummary = BuildOptionSummary(request);
        return new AcpSessionBindingDispatchResult(
            Accepted: true,
            Status: "accepted",
            Backend: "fake",
            DispatchMode: "fake",
            Message: $"fake ACP dispatch accepted ({optionSummary})",
            BackendSessionId: backendSessionId,
            ThreadBindingKey: request.Thread ? $"thread:{request.ChildSessionKey}" : null
        );
    }

    private AcpSessionBindingDispatchResult DispatchCommand(AcpSessionBindingDispatchRequest request)
    {
        if (string.IsNullOrWhiteSpace(_configuredCommand))
        {
            return new AcpSessionBindingDispatchResult(
                Accepted: false,
                Status: "error",
                Backend: "command",
                DispatchMode: "command",
                Message: "ACP adapter command mode requires OMNINODE_ACP_ADAPTER_COMMAND.",
                Error: "adapter command is missing"
            );
        }

        var payload = BuildCommandPayloadJson(request);

        var startInfo = new ProcessStartInfo
        {
            FileName = _configuredCommand,
            Arguments = string.Empty,
            WorkingDirectory = _workspaceRoot,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.Environment["OMNINODE_ACP_ADAPTER_CODEX_BIN"] = _codexBinaryPath;
        var codexApiKey = _runtimeSettings.GetCodexApiKey();
        if (!string.IsNullOrWhiteSpace(codexApiKey))
        {
            startInfo.Environment["OPENAI_API_KEY"] = codexApiKey.Trim();
        }

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                return new AcpSessionBindingDispatchResult(
                    Accepted: false,
                    Status: "error",
                    Backend: "command",
                    DispatchMode: "command",
                    Message: "failed to start ACP adapter command process",
                    Error: "process start returned false"
                );
            }
        }
        catch (Exception ex)
        {
            return new AcpSessionBindingDispatchResult(
                Accepted: false,
                Status: "error",
                Backend: "command",
                DispatchMode: "command",
                Message: $"failed to start ACP adapter command: {ex.Message}",
                Error: ex.Message
            );
        }

        try
        {
            process.StandardInput.Write(payload);
            process.StandardInput.Close();
        }
        catch (Exception ex)
        {
            TryKill(process);
            return new AcpSessionBindingDispatchResult(
                Accepted: false,
                Status: "error",
                Backend: "command",
                DispatchMode: "command",
                Message: $"failed to write ACP adapter payload: {ex.Message}",
                Error: ex.Message
            );
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var timeoutMs = ResolveTimeoutMs(request.RunTimeoutSeconds);
        if (!process.WaitForExit(timeoutMs))
        {
            TryKill(process);
            var timeoutError =
                $"ACP adapter command timeout ({timeoutMs.ToString(CultureInfo.InvariantCulture)} ms): {_configuredCommand}";
            return new AcpSessionBindingDispatchResult(
                Accepted: false,
                Status: "error",
                Backend: "command",
                DispatchMode: "command",
                Message: timeoutError,
                Error: timeoutError
            );
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        var parsed = TryParseCommandResult(stdout);
        if ((process.ExitCode != 0) || (parsed is not null && !parsed.Accepted))
        {
            var parsedError = parsed?.Error;
            var stderrTrimmed = TrimLine(stderr);
            var stdoutTrimmed = TrimLine(stdout);
            var resolvedError = !string.IsNullOrWhiteSpace(parsedError)
                ? parsedError
                : !string.IsNullOrWhiteSpace(stderrTrimmed)
                    ? stderrTrimmed
                    : !string.IsNullOrWhiteSpace(stdoutTrimmed)
                        ? stdoutTrimmed
                        : $"adapter exited with code {process.ExitCode.ToString(CultureInfo.InvariantCulture)}";
            return new AcpSessionBindingDispatchResult(
                Accepted: false,
                Status: "error",
                Backend: parsed?.Backend ?? "command",
                DispatchMode: "command",
                Message: "ACP adapter command returned an error",
                Error: resolvedError,
                BackendSessionId: parsed?.BackendSessionId,
                ThreadBindingKey: parsed?.ThreadBindingKey,
                RawOutput: parsed?.RawOutput ?? TrimRawOutput(stdout)
            );
        }

        if (parsed is not null)
        {
            return new AcpSessionBindingDispatchResult(
                Accepted: parsed.Accepted,
                Status: parsed.Status,
                Backend: parsed.Backend,
                DispatchMode: "command",
                Message: parsed.Message,
                Error: parsed.Error,
                BackendSessionId: parsed.BackendSessionId,
                ThreadBindingKey: parsed.ThreadBindingKey,
                RawOutput: parsed.RawOutput ?? TrimRawOutput(stdout)
            );
        }

        return new AcpSessionBindingDispatchResult(
            Accepted: true,
            Status: "accepted",
            Backend: "command",
            DispatchMode: "command",
            Message: "ACP adapter command accepted the dispatch payload.",
            RawOutput: TrimRawOutput(stdout)
        );
    }

    private static int ResolveTimeoutMs(int runTimeoutSeconds)
    {
        var fromEnvRaw = (Environment.GetEnvironmentVariable("OMNINODE_ACP_ADAPTER_TIMEOUT_MS") ?? string.Empty).Trim();
        if (int.TryParse(fromEnvRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var fromEnv)
            && fromEnv > 0)
        {
            return Math.Clamp(fromEnv, 1_000, MaxAdapterTimeoutMs);
        }

        if (runTimeoutSeconds > 0)
        {
            var fromRunTimeout = checked(runTimeoutSeconds * 1_000);
            return Math.Clamp(fromRunTimeout, 1_000, MaxAdapterTimeoutMs);
        }

        return DefaultAdapterTimeoutMs;
    }

    private static ParsedCommandResult? TryParseCommandResult(string? raw)
    {
        var normalized = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(normalized);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var root = doc.RootElement;
            var status = ReadString(root, "status");
            if (string.IsNullOrWhiteSpace(status))
            {
                status = "accepted";
            }

            var normalizedStatus = status.Trim().ToLowerInvariant();
            var accepted = normalizedStatus is "ok" or "accepted" or "success";
            var message = ReadString(root, "message");
            var backend = ReadString(root, "backend");
            var error = ReadString(root, "error");
            return new ParsedCommandResult(
                Accepted: accepted,
                Status: normalizedStatus,
                Backend: string.IsNullOrWhiteSpace(backend) ? "command" : backend.Trim(),
                Message: string.IsNullOrWhiteSpace(message)
                    ? accepted
                        ? "adapter command accepted dispatch payload."
                        : "adapter command returned error."
                    : TrimLine(message),
                Error: string.IsNullOrWhiteSpace(error) ? null : TrimLine(error),
                BackendSessionId: NormalizeOptional(ReadString(root, "backendSessionId")),
                ThreadBindingKey: NormalizeOptional(ReadString(root, "threadBindingKey")),
                RawOutput: NormalizeOptional(ReadString(root, "rawOutput"))
            );
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string BuildOptionSummary(AcpSessionBindingDispatchRequest request)
    {
        var tokens = new List<string>(3);
        if (!string.IsNullOrWhiteSpace(request.Model))
        {
            tokens.Add($"model={TrimLine(request.Model)}");
        }

        if (!string.IsNullOrWhiteSpace(request.Thinking))
        {
            tokens.Add($"thinking={TrimLine(request.Thinking)}");
        }

        if (request.LightContext.HasValue)
        {
            tokens.Add($"lightContext={(request.LightContext.Value ? "true" : "false")}");
        }

        if (tokens.Count == 0)
        {
            return "options=none";
        }

        return string.Join(", ", tokens);
    }

    private static string ResolveDispatchMode(string configuredMode, string? command)
    {
        if (!string.Equals(configuredMode, "auto", StringComparison.Ordinal))
        {
            return configuredMode;
        }

        return string.IsNullOrWhiteSpace(command) ? "staged" : "command";
    }

    private static string NormalizeMode(string? rawMode)
    {
        var normalized = (rawMode ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "fake" => "fake",
            "command" => "command",
            "staged" => "staged",
            _ => "auto"
        };
    }

    private static string? ResolveBundledAdapterCommand(string workspaceRoot)
    {
        if (!CommandExistsOnPath("codex"))
        {
            return null;
        }

        foreach (var candidate in EnumerateBundledAdapterCandidates(workspaceRoot))
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static IEnumerable<string> EnumerateBundledAdapterCandidates(string workspaceRoot)
    {
        var yielded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var currentDir = Directory.GetCurrentDirectory();
        foreach (var path in new[]
                 {
                     Path.Combine(currentDir, BundledCodexAdapterRelativePath),
                     Path.Combine(currentDir, "tools", "acp-adapter-codex-exec.js"),
                     Path.Combine(workspaceRoot, "..", BundledCodexAdapterRelativePath),
                     Path.Combine(workspaceRoot, "..", "tools", "acp-adapter-codex-exec.js"),
                     Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "tools", "acp-adapter-codex-exec.js")
                 })
        {
            var fullPath = Path.GetFullPath(path);
            if (yielded.Add(fullPath))
            {
                yield return fullPath;
            }
        }
    }

    private static bool CommandExistsOnPath(string command)
    {
        var pathValue = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathValue))
        {
            return false;
        }

        foreach (var rawSegment in pathValue.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(rawSegment))
            {
                continue;
            }

            var candidate = Path.Combine(rawSegment.Trim(), command);
            if (File.Exists(candidate))
            {
                return true;
            }
        }

        return false;
    }

    private static string? ReadString(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var element))
        {
            return null;
        }

        return element.ValueKind == JsonValueKind.String ? element.GetString() : null;
    }

    private static string? NormalizeOptional(string? text)
    {
        var normalized = (text ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static string TrimLine(string? text)
    {
        var normalized = (text ?? string.Empty)
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
        if (normalized.Length <= 240)
        {
            return normalized;
        }

        return normalized[..240].TrimEnd() + "...";
    }

    private static string? TrimRawOutput(string? text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        const int maxChars = 1_200;
        if (normalized.Length <= maxChars)
        {
            return normalized;
        }

        return normalized[..maxChars] + "...";
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best-effort termination only.
        }
    }

    private sealed record ParsedCommandResult(
        bool Accepted,
        string Status,
        string Backend,
        string Message,
        string? Error,
        string? BackendSessionId,
        string? ThreadBindingKey,
        string? RawOutput
    );

    private static string BuildCommandPayloadJson(AcpSessionBindingDispatchRequest request)
    {
        var builder = new System.Text.StringBuilder();
        builder.Append("{");
        builder.Append($"\"runId\":\"{EscapeJson(request.RunId)}\",");
        builder.Append($"\"childSessionKey\":\"{EscapeJson(request.ChildSessionKey)}\",");
        builder.Append($"\"mode\":\"{EscapeJson(request.Mode)}\",");
        builder.Append($"\"task\":\"{EscapeJson(request.Task)}\",");
        builder.Append($"\"runTimeoutSeconds\":{request.RunTimeoutSeconds.ToString(CultureInfo.InvariantCulture)},");
        builder.Append($"\"thread\":{(request.Thread ? "true" : "false")},");
        builder.Append("\"options\":{");
        builder.Append($"\"model\":{ToNullableJsonString(request.Model)},");
        builder.Append($"\"thinking\":{ToNullableJsonString(request.Thinking)},");
        builder.Append($"\"lightContext\":{(request.LightContext.HasValue ? (request.LightContext.Value ? "true" : "false") : "null")}");
        builder.Append("}");
        builder.Append("}");
        return builder.ToString();
    }

    private static string ToNullableJsonString(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? "null"
            : $"\"{EscapeJson(value)}\"";
    }

    private static string EscapeJson(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal)
            .Replace("\t", "\\t", StringComparison.Ordinal);
    }
}
