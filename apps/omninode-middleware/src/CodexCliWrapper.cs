using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed class CodexCliWrapper
{
    private const string DefaultCodexModel = "gpt-5.4";
    private static readonly Regex AnsiEscapeRegex = new(
        "\u001B\\[[0-9;]*[A-Za-z]",
        RegexOptions.Compiled
    );
    private static readonly Regex DeviceCodeRegex = new(
        @"one-time code(?:\s*\(.*?\))?\s*([A-Z0-9-]{7,20})",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex DeviceUrlRegex = new(
        @"https://auth\.openai\.com/codex/device\S*",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );

    private readonly string _codexBinaryPath;
    private readonly RuntimeSettings _runtimeSettings;
    private readonly string _workspaceRoot;
    private readonly string _defaultModel;
    private readonly int _requestTimeoutSec;
    private readonly object _loginLock = new();
    private LoginSession? _activeLoginSession;

    public CodexCliWrapper(
        string codexBinaryPath,
        RuntimeSettings runtimeSettings,
        string workspaceRoot,
        string? defaultModel = null,
        int requestTimeoutSec = 45
    )
    {
        _codexBinaryPath = string.IsNullOrWhiteSpace(codexBinaryPath) ? "codex" : codexBinaryPath.Trim();
        _runtimeSettings = runtimeSettings;
        _workspaceRoot = string.IsNullOrWhiteSpace(workspaceRoot) ? Directory.GetCurrentDirectory() : workspaceRoot.Trim();
        _defaultModel = string.IsNullOrWhiteSpace(defaultModel) ? DefaultCodexModel : defaultModel.Trim();
        _requestTimeoutSec = Math.Max(10, requestTimeoutSec);
    }

    public async Task<CodexStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        if (!await IsInstalledAsync(cancellationToken))
        {
            return new CodexStatus(false, false, "none", "codex CLI not found");
        }

        LoginSession? runningSession;
        lock (_loginLock)
        {
            runningSession = _activeLoginSession != null && !_activeLoginSession.Process.HasExited
                ? _activeLoginSession
                : null;
        }

        if (runningSession != null)
        {
            var runningOutputRaw = runningSession.GetRawOutputSnapshot();
            var code = ExtractDeviceCode(runningOutputRaw) ?? "-";
            var url = ExtractDeviceUrl(runningOutputRaw) ?? "https://auth.openai.com/codex/device";
            return new CodexStatus(true, false, "device_auth", $"login pending. code={code} url={url}");
        }

        using var timeoutCts = CreateTimeoutToken(cancellationToken);
        var result = await RunProcessAsync(_codexBinaryPath, new[] { "login", "status" }, timeoutCts.Token);
        var merged = NormalizeText($"{result.StdOut}\n{result.StdErr}");
        if (result.ExitCode == 0)
        {
            var mode = ResolveMode(merged);
            var detail = string.IsNullOrWhiteSpace(merged) ? "ready" : merged;
            return new CodexStatus(true, true, mode, detail);
        }

        if (!string.IsNullOrWhiteSpace(_runtimeSettings.GetCodexApiKey()))
        {
            return new CodexStatus(true, true, "omninode_api_key", "ready (Omni-node secure API key)");
        }

        if (merged.Contains("Not logged in", StringComparison.OrdinalIgnoreCase))
        {
            return new CodexStatus(true, false, "codex", "not logged in");
        }

        return new CodexStatus(
            true,
            false,
            "codex",
            string.IsNullOrWhiteSpace(merged) ? "status check failed" : merged
        );
    }

    public async Task<string> StartLoginAsync(CancellationToken cancellationToken)
    {
        if (!await IsInstalledAsync(cancellationToken))
        {
            return "codex cli not found";
        }

        var currentStatus = await GetStatusAsync(cancellationToken);
        if (currentStatus.Authenticated && !currentStatus.Mode.Equals("device_auth", StringComparison.OrdinalIgnoreCase))
        {
            return $"codex 이미 인증 완료 ({currentStatus.Mode})";
        }

        LoginSession session;
        lock (_loginLock)
        {
            if (_activeLoginSession != null && !_activeLoginSession.Process.HasExited)
            {
                var runningOutput = _activeLoginSession.GetRawOutputSnapshot();
                var runningCode = ExtractDeviceCode(runningOutput) ?? "-";
                var runningUrl = ExtractDeviceUrl(runningOutput) ?? "https://auth.openai.com/codex/device";
                return $"codex login is already running. code={runningCode} url={runningUrl}";
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = _codexBinaryPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add("login");
            startInfo.ArgumentList.Add("--device-auth");

            var process = new Process { StartInfo = startInfo };
            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                process.Dispose();
                return $"codex login start failed: {Trim(ex.Message, 500)}";
            }

            session = new LoginSession(process);
            _activeLoginSession = session;
            session.StdOutPump = PumpLoginStreamAsync(process.StandardOutput, session);
            session.StdErrPump = PumpLoginStreamAsync(process.StandardError, session);
            _ = TrackLoginSessionAsync(session);
        }

        return await BuildLoginBootstrapMessageAsync(session, cancellationToken);
    }

    public async Task<string> LogoutAsync(CancellationToken cancellationToken)
    {
        LoginSession? runningSession = null;
        lock (_loginLock)
        {
            if (_activeLoginSession != null && !_activeLoginSession.Process.HasExited)
            {
                runningSession = _activeLoginSession;
                _activeLoginSession = null;
            }
        }

        if (runningSession != null)
        {
            TryKill(runningSession.Process);
            runningSession.Process.Dispose();
        }

        if (!await IsInstalledAsync(cancellationToken))
        {
            return "codex cli not found";
        }

        using var timeoutCts = CreateTimeoutToken(cancellationToken);
        var result = await RunProcessAsync(_codexBinaryPath, new[] { "logout" }, timeoutCts.Token);
        var merged = NormalizeText($"{result.StdOut}\n{result.StdErr}");
        if (result.ExitCode == 0)
        {
            return string.IsNullOrWhiteSpace(merged) ? "codex logout completed" : merged;
        }

        return $"codex logout failed: {Trim(string.IsNullOrWhiteSpace(merged) ? "unknown error" : merged, 700)}";
    }

    public async Task<string> GenerateChatAsync(
        string prompt,
        string? modelOverride,
        CancellationToken cancellationToken,
        bool useChatEnvelope = true,
        string? workingDirectoryOverride = null,
        bool useCodingProfile = false
    )
    {
        var input = (prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(input))
        {
            return "empty input";
        }

        if (!await IsInstalledAsync(cancellationToken))
        {
            return "codex cli not found";
        }

        var status = await GetStatusAsync(cancellationToken);
        if (!status.Authenticated)
        {
            return "codex 인증이 필요합니다. 설정 탭에서 OAuth 또는 API Key를 확인하세요.";
        }

        var model = string.IsNullOrWhiteSpace(modelOverride) ? _defaultModel : modelOverride.Trim();
        var workingDirectory = ResolveWorkingDirectory(workingDirectoryOverride);
        var tempDir = string.Empty;
        try
        {
            tempDir = Directory.CreateTempSubdirectory("omninode-codex-chat-").FullName;
            var outputPath = Path.Combine(tempDir, "last-message.txt");
            var effectivePrompt = useChatEnvelope ? BuildChatPrompt(input) : input;
            var args = new List<string>();
            if (useCodingProfile)
            {
                args.Add("-c");
                args.Add("mcp_servers.playwright.enabled=false");
                args.Add("-c");
                args.Add("model_reasoning_effort=\"low\"");
            }

            args.Add("-a");
            args.Add("never");
            args.Add("exec");
            args.Add("-C");
            args.Add(workingDirectory);
            if (useCodingProfile)
            {
                args.Add("--skip-git-repo-check");
            }

            args.Add("--sandbox");
            args.Add("read-only");
            args.Add("--color");
            args.Add("never");
            args.Add("-o");
            args.Add(outputPath);
            args.Add("-m");
            args.Add(model);
            args.Add(effectivePrompt);
            using var timeoutCts = CreateTimeoutToken(cancellationToken);
            var result = await RunProcessAsync(
                _codexBinaryPath,
                args,
                timeoutCts.Token
            );

            var finalMessage = string.Empty;
            try
            {
                if (File.Exists(outputPath))
                {
                    finalMessage = (await File.ReadAllTextAsync(outputPath, cancellationToken)).Trim();
                }
            }
            catch
            {
            }

            if (result.ExitCode != 0)
            {
                var mergedError = NormalizeText($"{result.StdErr}\n{result.StdOut}");
                return $"codex 요청 실패: {Trim(string.IsNullOrWhiteSpace(mergedError) ? "unknown error" : mergedError, 700)}";
            }

            if (!string.IsNullOrWhiteSpace(finalMessage))
            {
                return finalMessage;
            }

            var stdout = (result.StdOut ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(stdout))
            {
                return stdout;
            }

            var stderr = NormalizeText(result.StdErr);
            return string.IsNullOrWhiteSpace(stderr) ? "codex 응답이 비어 있습니다." : stderr;
        }
        catch (OperationCanceledException)
        {
            return "codex 응답 시간이 초과되었습니다.";
        }
        catch (Exception ex)
        {
            return $"codex 호출 오류: {Trim(ex.Message, 700)}";
        }
        finally
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(tempDir) && Directory.Exists(tempDir))
                {
                    Directory.Delete(tempDir, recursive: true);
                }
            }
            catch
            {
            }
        }
    }

    private string ResolveWorkingDirectory(string? workingDirectoryOverride)
    {
        var candidate = string.IsNullOrWhiteSpace(workingDirectoryOverride)
            ? _workspaceRoot
            : workingDirectoryOverride.Trim();
        try
        {
            if (Directory.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }
        catch
        {
        }

        return _workspaceRoot;
    }

    private async Task<bool> IsInstalledAsync(CancellationToken cancellationToken)
    {
        using var timeoutCts = CreateTimeoutToken(cancellationToken);
        var result = await RunProcessAsync(_codexBinaryPath, new[] { "--version" }, timeoutCts.Token);
        return result.ExitCode == 0;
    }

    private async Task<string> BuildLoginBootstrapMessageAsync(LoginSession session, CancellationToken cancellationToken)
    {
        try
        {
            var waitTask = Task.WhenAny(
                session.HintReceived.Task,
                Task.Delay(TimeSpan.FromSeconds(4), cancellationToken),
                session.Process.WaitForExitAsync(cancellationToken)
            );
            await waitTask;
        }
        catch (OperationCanceledException)
        {
            return "codex OAuth 로그인 시작. 브라우저에서 인증을 완료하세요.";
        }

        var outputRaw = session.GetRawOutputSnapshot();
        var output = NormalizeText(outputRaw);
        var code = ExtractDeviceCode(outputRaw);
        var url = ExtractDeviceUrl(outputRaw);
        if (!string.IsNullOrWhiteSpace(code) || !string.IsNullOrWhiteSpace(url))
        {
            return $"codex OAuth 로그인 시작. code={code ?? "-"} url={url ?? "-"}";
        }

        if (session.Process.HasExited)
        {
            return session.Process.ExitCode == 0
                ? "codex login command completed."
                : $"codex login failed: {Trim(output, 700)}";
        }

        return "codex OAuth 로그인 시작. 브라우저/디바이스 인증 흐름을 진행하세요.";
    }

    private async Task TrackLoginSessionAsync(LoginSession session)
    {
        try
        {
            await Task.WhenAll(
                session.StdOutPump ?? Task.CompletedTask,
                session.StdErrPump ?? Task.CompletedTask,
                session.Process.WaitForExitAsync()
            );
        }
        catch
        {
        }
        finally
        {
            lock (_loginLock)
            {
                if (ReferenceEquals(_activeLoginSession, session))
                {
                    _activeLoginSession = null;
                }
            }

            session.Process.Dispose();
        }
    }

    private static async Task PumpLoginStreamAsync(StreamReader reader, LoginSession session)
    {
        try
        {
            while (true)
            {
                var line = await reader.ReadLineAsync();
                if (line == null)
                {
                    break;
                }

                session.AppendOutput(line);
                if (line.Contains("one-time code", StringComparison.OrdinalIgnoreCase)
                    || line.Contains("auth.openai.com/codex/device", StringComparison.OrdinalIgnoreCase))
                {
                    session.HintReceived.TrySetResult(true);
                }
            }
        }
        catch
        {
        }
    }

    private static string ResolveMode(string normalizedStatusText)
    {
        if (normalizedStatusText.Contains("ChatGPT", StringComparison.OrdinalIgnoreCase))
        {
            return "chatgpt";
        }

        if (normalizedStatusText.Contains("API key", StringComparison.OrdinalIgnoreCase))
        {
            return "api_key";
        }

        return "codex";
    }

    private static string? ExtractDeviceCode(string? text)
    {
        var raw = text ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var stripped = AnsiEscapeRegex.Replace(raw, string.Empty);
        var compact = Regex.Replace(stripped, @"\s+", " ");
        var match = DeviceCodeRegex.Match(compact);
        return match.Success ? match.Groups[1].Value.Trim() : null;
    }

    private static string? ExtractDeviceUrl(string? text)
    {
        var raw = text ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var stripped = AnsiEscapeRegex.Replace(raw, string.Empty);
        var match = DeviceUrlRegex.Match(stripped);
        return match.Success ? match.Value.Trim() : null;
    }

    private static string NormalizeText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var stripped = AnsiEscapeRegex.Replace(text, string.Empty);
        var lines = stripped
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToArray();
        return string.Join(" | ", lines);
    }

    private CancellationTokenSource CreateTimeoutToken(CancellationToken outerToken)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
        cts.CancelAfter(TimeSpan.FromSeconds(_requestTimeoutSec));
        return cts;
    }

    private async Task<ProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> args,
        CancellationToken cancellationToken
    )
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        var codexApiKey = _runtimeSettings.GetCodexApiKey();
        if (!string.IsNullOrWhiteSpace(codexApiKey))
        {
            startInfo.Environment["OPENAI_API_KEY"] = codexApiKey.Trim();
        }

        try
        {
            using var process = new Process { StartInfo = startInfo };
            process.Start();
            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            try
            {
                await process.WaitForExitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                TryKill(process);
                throw;
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            return new ProcessResult(process.ExitCode, stdout, stderr);
        }
        catch (Exception ex)
        {
            return new ProcessResult(127, string.Empty, ex.Message);
        }
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
        }
    }

    private static string Trim(string value, int max)
    {
        return value.Length <= max ? value : value[..max] + "...(truncated)";
    }

    private static string BuildChatPrompt(string input)
    {
        return $"""
                너는 Omni-node에서 호출되는 텍스트 전용 답변기다.
                반드시 지켜라:
                - 셸 명령 실행 금지
                - 파일 생성/수정/삭제 금지
                - 도구 호출/브라우저 제어 금지
                - 진행 로그, 사고과정, 메타 설명 금지
                - 최종 답변만 한국어로 작성

                [사용자 요청]
                {input}
                """;
    }

    private sealed class LoginSession
    {
        private readonly object _outputLock = new();
        private readonly StringBuilder _output = new();

        public LoginSession(Process process)
        {
            Process = process;
        }

        public Process Process { get; }
        public TaskCompletionSource<bool> HintReceived { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task? StdOutPump { get; set; }
        public Task? StdErrPump { get; set; }

        public void AppendOutput(string line)
        {
            lock (_outputLock)
            {
                _output.AppendLine(line);
            }
        }

        public string GetOutputSnapshot()
        {
            lock (_outputLock)
            {
                return NormalizeText(_output.ToString());
            }
        }

        public string GetRawOutputSnapshot()
        {
            lock (_outputLock)
            {
                return _output.ToString();
            }
        }
    }

    private sealed record ProcessResult(int ExitCode, string StdOut, string StdErr);
}

public sealed record CodexStatus(
    bool Installed,
    bool Authenticated,
    string Mode,
    string Detail
);
