using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Globalization;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed class WebSocketGateway
{
    private const int DefaultTrustedAuthTtlHours = 24;
    private const int MinTrustedAuthTtlHours = 1;
    private const int MaxTrustedAuthTtlHours = 168;
    private const string WebSocketPath = "/ws/";
    private const string GuardRetryTimelineApiPath = "/api/guard/retry-timeline";
    private const string GuardAlertDispatchMessageType = "dispatch_guard_alert";
    private const string GuardAlertDispatchResultType = "guard_alert_dispatch_result";
    private const string GuardAlertSchemaVersion = "guard_alert_event.v1";
    private const string GuardAlertEventType = "omninode.guard_alert.summary";
    private const string CitationValidationBlockedToken = "근거 인용 검증에 실패하여 fail-closed 정책으로 답변을 차단했습니다";
    private static readonly Regex AnswerGuardBlockedPattern = new(
        @"answer-guard blocked\s*\(\s*category=(?<category>[^,\)]+)\s*,\s*reason=(?<reason>[^,\)]+)(?:\s*,\s*detail=(?<detail>.*?))?(?:\s*,\s*target=\d+\s*,\s*collected=\d+)?\s*\)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex GroundedFailureReasonPattern = new(
        @"원인\s*코드:\s*(?<reason>[^\r\n]+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex GroundedFailureTerminationPattern = new(
        @"종료\s*코드:\s*(?<termination>[^\r\n]+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex GroundedFailureDetailPattern = new(
        @"상세:\s*(?<detail>[^\r\n]+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly HttpClient GuardAlertPipelineHttpClient = new()
    {
        Timeout = Timeout.InfiniteTimeSpan
    };
    private readonly AppConfig _config;
    private readonly int _port;
    private readonly SessionManager _sessionManager;
    private readonly TelegramClient _telegramClient;
    private readonly CommandService _commandService;
    private readonly LlmRouter _llmRouter;
    private readonly GroqModelCatalog _groqModelCatalog;
    private readonly GuardRetryTimelineStore _guardRetryTimelineStore;
    private readonly AuditLogger _auditLogger;
    private readonly string _dashboardRootPath;
    private readonly Dictionary<string, RateWindow> _sessionRateMap = new();
    private readonly object _rateLock = new();
    private readonly object _gatewayHealthLock = new();
    private long _webSocketAcceptedCount;
    private long _webSocketRoundTripCount;
    private long _lastWebSocketAcceptedUnixMs;
    private long _lastWebSocketRoundTripUnixMs;
    private string _gatewayHealthStatus = "starting";
    private string _gatewayListenerPrefix = string.Empty;
    private bool _gatewayListenerBound;
    private bool _gatewayDegradedMode;
    private int? _gatewayListenerErrorCode;
    private string? _gatewayListenerErrorMessage;

    private sealed record GuardAlertDispatchTargetResult(
        string Name,
        string Status,
        int Attempts,
        int? StatusCode,
        string Error,
        string Endpoint
    );

    private sealed record GuardAlertDispatchResult(
        bool Ok,
        string Status,
        string Message,
        string SchemaVersion,
        string EventType,
        string AttemptedAtUtc,
        IReadOnlyList<GuardAlertDispatchTargetResult> Targets
    );

    public WebSocketGateway(
        AppConfig config,
        int port,
        SessionManager sessionManager,
        TelegramClient telegramClient,
        CommandService commandService,
        LlmRouter llmRouter,
        GroqModelCatalog groqModelCatalog,
        GuardRetryTimelineStore guardRetryTimelineStore,
        AuditLogger auditLogger
    )
    {
        _config = config;
        _port = port;
        _sessionManager = sessionManager;
        _telegramClient = telegramClient;
        _commandService = commandService;
        _llmRouter = llmRouter;
        _groqModelCatalog = groqModelCatalog;
        _guardRetryTimelineStore = guardRetryTimelineStore;
        _auditLogger = auditLogger;
        _dashboardRootPath = Path.GetDirectoryName(Path.GetFullPath(config.DashboardIndexPath))
                             ?? Path.GetFullPath(".");
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var listenerPrefix = $"http://127.0.0.1:{_port}/";
        SetGatewayHealthState(
            status: "starting",
            listenerPrefix: listenerPrefix,
            listenerBound: false,
            degradedMode: false
        );

        using var listener = new HttpListener();
        listener.Prefixes.Add(listenerPrefix);
        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            Console.Error.WriteLine(
                $"[web] listener start failed (prefix={listenerPrefix}, error={ex.ErrorCode}): {ex.Message}"
            );
            Console.Error.WriteLine("[web] degraded mode enabled: websocket/dashboard listener unavailable");
            SetGatewayHealthState(
                status: "degraded",
                listenerPrefix: listenerPrefix,
                listenerBound: false,
                degradedMode: true,
                listenerErrorCode: ex.ErrorCode,
                listenerErrorMessage: ex.Message
            );
            await WaitForCancellationAsync(cancellationToken);
            SetGatewayHealthState(
                status: "stopped",
                listenerPrefix: listenerPrefix,
                listenerBound: false,
                degradedMode: true,
                listenerErrorCode: ex.ErrorCode,
                listenerErrorMessage: ex.Message
            );
            return;
        }

        Console.WriteLine($"[web] dashboard=http://127.0.0.1:{_port}/ ws=ws://127.0.0.1:{_port}/ws/");
        SetGatewayHealthState(
            status: "ok",
            listenerPrefix: listenerPrefix,
            listenerBound: true,
            degradedMode: false
        );

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync().WaitAsync(cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (HttpListenerException)
                {
                    break;
                }

                _ = HandleContextAsync(context, cancellationToken);
            }
        }
        finally
        {
            if (listener.IsListening)
            {
                listener.Stop();
            }

            SetGatewayHealthState(
                status: "stopped",
                listenerPrefix: listenerPrefix,
                listenerBound: false,
                degradedMode: false
            );
        }
    }

    private static async Task WaitForCancellationAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // 종료 시그널 수신 시 정상 종료 경로로 복귀한다.
        }
    }

    private void SetGatewayHealthState(
        string status,
        string listenerPrefix,
        bool listenerBound,
        bool degradedMode,
        int? listenerErrorCode = null,
        string? listenerErrorMessage = null
    )
    {
        lock (_gatewayHealthLock)
        {
            _gatewayHealthStatus = status;
            _gatewayListenerPrefix = listenerPrefix;
            _gatewayListenerBound = listenerBound;
            _gatewayDegradedMode = degradedMode;
            _gatewayListenerErrorCode = listenerErrorCode;
            _gatewayListenerErrorMessage = listenerErrorMessage;
        }

        WriteGatewayHealthSnapshot(
            status,
            listenerPrefix,
            listenerBound,
            degradedMode,
            listenerErrorCode,
            listenerErrorMessage
        );
    }

    private void RefreshGatewayHealthSnapshot()
    {
        string status;
        string listenerPrefix;
        bool listenerBound;
        bool degradedMode;
        int? listenerErrorCode;
        string? listenerErrorMessage;

        lock (_gatewayHealthLock)
        {
            status = _gatewayHealthStatus;
            listenerPrefix = _gatewayListenerPrefix;
            listenerBound = _gatewayListenerBound;
            degradedMode = _gatewayDegradedMode;
            listenerErrorCode = _gatewayListenerErrorCode;
            listenerErrorMessage = _gatewayListenerErrorMessage;
        }

        if (string.IsNullOrWhiteSpace(listenerPrefix))
        {
            return;
        }

        WriteGatewayHealthSnapshot(
            status,
            listenerPrefix,
            listenerBound,
            degradedMode,
            listenerErrorCode,
            listenerErrorMessage
        );
    }

    private void MarkWebSocketAccepted()
    {
        var acceptedCount = Interlocked.Increment(ref _webSocketAcceptedCount);
        Interlocked.Exchange(ref _lastWebSocketAcceptedUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (acceptedCount == 1)
        {
            RefreshGatewayHealthSnapshot();
        }
    }

    private void MarkWebSocketRoundTrip()
    {
        var roundTripCount = Interlocked.Increment(ref _webSocketRoundTripCount);
        Interlocked.Exchange(ref _lastWebSocketRoundTripUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (roundTripCount == 1)
        {
            Console.WriteLine("[web] ready probe satisfied: websocket ping/pong round-trip observed");
            RefreshGatewayHealthSnapshot();
        }
    }

    private static string BuildTimestampJsonValue(long unixTimeMilliseconds)
    {
        if (unixTimeMilliseconds <= 0)
        {
            return "null";
        }

        var timestamp = DateTimeOffset.FromUnixTimeMilliseconds(unixTimeMilliseconds).ToString("O");
        return $"\"{EscapeJson(timestamp)}\"";
    }

    private static bool TryResolveProbeStatus(string path, out string probeStatus)
    {
        switch (path)
        {
            case "/health":
            case "/healthz":
                probeStatus = "live";
                return true;
            case "/ready":
            case "/readyz":
                probeStatus = "ready";
                return true;
            default:
                probeStatus = string.Empty;
                return false;
        }
    }

    private bool IsReadyProbeSatisfied()
    {
        return Interlocked.Read(ref _webSocketRoundTripCount) > 0;
    }

    private string BuildProbeResponseJson(string probeStatus, bool ok)
    {
        var acceptedCount = Interlocked.Read(ref _webSocketAcceptedCount);
        var roundTripCount = Interlocked.Read(ref _webSocketRoundTripCount);
        var lastAccepted = Interlocked.Read(ref _lastWebSocketAcceptedUnixMs);
        var lastRoundTrip = Interlocked.Read(ref _lastWebSocketRoundTripUnixMs);
        var ready = IsReadyProbeSatisfied();
        var reason = probeStatus == "ready" && !ok ? "\"awaiting_websocket_roundtrip\"" : "null";
        return "{"
            + $"\"ok\":{(ok ? "true" : "false")},"
            + $"\"status\":\"{EscapeJson(ok ? "ok" : "not_ready")}\","
            + $"\"probe\":\"{EscapeJson(probeStatus)}\","
            + $"\"webSocketPath\":\"{EscapeJson(WebSocketPath)}\","
            + $"\"webSocketAcceptedCount\":{acceptedCount},"
            + $"\"webSocketRoundTripCount\":{roundTripCount},"
            + $"\"lastWebSocketAcceptedUtc\":{BuildTimestampJsonValue(lastAccepted)},"
            + $"\"lastWebSocketRoundTripUtc\":{BuildTimestampJsonValue(lastRoundTrip)},"
            + $"\"ready\":{(ready ? "true" : "false")},"
            + $"\"reason\":{reason}"
            + "}";
    }

    private void WriteGatewayHealthSnapshot(
        string status,
        string listenerPrefix,
        bool listenerBound,
        bool degradedMode,
        int? listenerErrorCode = null,
        string? listenerErrorMessage = null
    )
    {
        try
        {
            var acceptedCount = Interlocked.Read(ref _webSocketAcceptedCount);
            var roundTripCount = Interlocked.Read(ref _webSocketRoundTripCount);
            var lastAccepted = Interlocked.Read(ref _lastWebSocketAcceptedUnixMs);
            var lastRoundTrip = Interlocked.Read(ref _lastWebSocketRoundTripUnixMs);
            var readyForProbe = IsReadyProbeSatisfied();
            var readyReason = readyForProbe ? "null" : "\"awaiting_websocket_roundtrip\"";
            var payload = "{"
                + $"\"status\":\"{EscapeJson(status)}\","
                + $"\"listenerBound\":{(listenerBound ? "true" : "false")},"
                + $"\"degradedMode\":{(degradedMode ? "true" : "false")},"
                + $"\"port\":{_port},"
                + $"\"prefix\":\"{EscapeJson(listenerPrefix)}\","
                + $"\"healthEndpointPath\":{(_config.EnableHealthEndpoint ? "\"/healthz\"" : "null")},"
                + $"\"readyEndpointPath\":{(_config.EnableHealthEndpoint ? "\"/readyz\"" : "null")},"
                + $"\"webSocketPath\":\"{EscapeJson(WebSocketPath)}\","
                + $"\"webSocketAcceptedCount\":{acceptedCount},"
                + $"\"webSocketRoundTripCount\":{roundTripCount},"
                + $"\"lastWebSocketAcceptedUtc\":{BuildTimestampJsonValue(lastAccepted)},"
                + $"\"lastWebSocketRoundTripUtc\":{BuildTimestampJsonValue(lastRoundTrip)},"
                + $"\"webSocketReady\":{(readyForProbe ? "true" : "false")},"
                + $"\"readyReason\":{readyReason},"
                + $"\"listenerErrorCode\":{(listenerErrorCode.HasValue ? listenerErrorCode.Value.ToString(CultureInfo.InvariantCulture) : "null")},"
                + $"\"listenerErrorMessage\":{(listenerErrorMessage == null ? "null" : $"\"{EscapeJson(listenerErrorMessage)}\"")},"
                + $"\"updatedAtUtc\":\"{EscapeJson(DateTimeOffset.UtcNow.ToString("O"))}\""
                + "}";
            AtomicFileStore.WriteAllText(_config.GatewayHealthStatePath, payload, ownerOnly: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[web] health snapshot write failed (path={_config.GatewayHealthStatePath}): {ex.Message}"
            );
        }
    }

    private async Task HandleContextAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var path = context.Request.Url?.AbsolutePath ?? "/";

        if (context.Request.IsWebSocketRequest && (path == "/ws" || path == "/ws/"))
        {
            await HandleWebSocketAsync(context, cancellationToken);
            return;
        }

        if (_config.EnableHealthEndpoint && TryResolveProbeStatus(path, out var probeStatus))
        {
            var method = context.Request.HttpMethod?.ToUpperInvariant() ?? "GET";
            if (method != "GET" && method != "HEAD")
            {
                context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
                context.Response.Headers["Allow"] = "GET, HEAD";
                await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "Method Not Allowed", cancellationToken);
                return;
            }

            var probeOk = probeStatus != "ready" || IsReadyProbeSatisfied();
            context.Response.StatusCode = probeOk
                ? (int)HttpStatusCode.OK
                : (int)HttpStatusCode.ServiceUnavailable;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.Headers["Cache-Control"] = "no-store";
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["X-Frame-Options"] = "DENY";
            if (method == "HEAD")
            {
                context.Response.ContentLength64 = 0;
                context.Response.OutputStream.Close();
                return;
            }

            await WriteResponseAsync(
                context.Response,
                "application/json; charset=utf-8",
                BuildProbeResponseJson(probeStatus, probeOk),
                cancellationToken
            );
            return;
        }

        if (path.Equals(GuardRetryTimelineApiPath, StringComparison.OrdinalIgnoreCase))
        {
            await HandleGuardRetryTimelineApiAsync(context, cancellationToken);
            return;
        }

        if (context.Request.HttpMethod.Equals("GET", StringComparison.OrdinalIgnoreCase))
        {
            if (TryResolveStaticAsset(path, out var filePath, out var contentType))
            {
                if (!File.Exists(filePath))
                {
                    context.Response.StatusCode = (int)HttpStatusCode.NotFound;
                    await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "asset not found", cancellationToken);
                    return;
                }

                var body = await File.ReadAllTextAsync(filePath, cancellationToken);
                context.Response.StatusCode = (int)HttpStatusCode.OK;
                await WriteResponseAsync(context.Response, contentType, body, cancellationToken);
                return;
            }
        }

        context.Response.StatusCode = (int)HttpStatusCode.NotFound;
        await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "not found", cancellationToken);
    }

    private async Task HandleGuardRetryTimelineApiAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var method = context.Request.HttpMethod?.ToUpperInvariant() ?? "GET";
        if (method != "GET" && method != "HEAD")
        {
            context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
            context.Response.Headers["Allow"] = "GET, HEAD";
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "Method Not Allowed", cancellationToken);
            return;
        }

        var bucketMinutes = ParseQueryInt(
            context.Request.QueryString["bucketMinutes"],
            1,
            60
        );
        var windowMinutes = ParseQueryInt(
            context.Request.QueryString["windowMinutes"],
            1,
            24 * 60
        );
        var maxBucketRows = ParseQueryInt(
            context.Request.QueryString["maxBucketRows"],
            1,
            288
        );
        var channels = ParseChannelsQuery(context.Request.QueryString["channels"]);
        var payload = _guardRetryTimelineStore.BuildSnapshotJson(
            bucketMinutes: bucketMinutes,
            windowMinutes: windowMinutes,
            maxBucketRows: maxBucketRows,
            channels: channels
        );

        context.Response.StatusCode = (int)HttpStatusCode.OK;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        if (method == "HEAD")
        {
            context.Response.ContentLength64 = 0;
            context.Response.OutputStream.Close();
            return;
        }

        await WriteResponseAsync(
            context.Response,
            "application/json; charset=utf-8",
            payload,
            cancellationToken
        );
    }

    private static int? ParseQueryInt(string? raw, int min, int max)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return null;
        }

        return Math.Clamp(parsed, min, max);
    }

    private static string[]? ParseChannelsQuery(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var channels = raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return channels.Length > 0 ? channels : null;
    }

    private async Task HandleWebSocketAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        WebSocket? socket = null;
        string? sessionId = null;
        var sendLock = new SemaphoreSlim(1, 1);
        var streamCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task? streamTask = null;

        try
        {
            var wsContext = await context.AcceptWebSocketAsync(subProtocol: null);
            socket = wsContext.WebSocket;
            MarkWebSocketAccepted();
            var session = _sessionManager.CreatePending(TimeSpan.FromMinutes(3));
            sessionId = session.SessionId;

            await SendTextAsync(
                socket,
                sendLock,
                "{"
                + "\"type\":\"auth_required\","
                + $"\"sessionId\":\"{EscapeJson(sessionId)}\","
                + $"\"telegramConfigured\":{(_telegramClient.IsConfigured ? "true" : "false")}"
                + "}",
                cancellationToken
            );
            await SendSettingsStateAsync(socket, sendLock, cancellationToken);

            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                string? text;
                try
                {
                    text = await ReceiveTextAsync(socket, cancellationToken);
                }
                catch (InvalidOperationException ex)
                {
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"error\",\"message\":\"{EscapeJson(ex.Message)}\"}}", cancellationToken);
                    break;
                }

                if (text == null)
                {
                    break;
                }

                var message = ParseClientMessage(text);
                if (message == null)
                {
                    await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"invalid message format\"}", cancellationToken);
                    continue;
                }

                if (message.Type == "ping")
                {
                    MarkWebSocketRoundTrip();
                    var acceptedCount = Interlocked.Read(ref _webSocketAcceptedCount);
                    var roundTripCount = Interlocked.Read(ref _webSocketRoundTripCount);
                    var nowUtc = DateTimeOffset.UtcNow.ToString("O");
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"pong\","
                        + $"\"atUtc\":\"{EscapeJson(nowUtc)}\","
                        + $"\"webSocketAcceptedCount\":{acceptedCount},"
                        + $"\"webSocketRoundTripCount\":{roundTripCount}"
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "request_otp")
                {
                    if (string.IsNullOrWhiteSpace(sessionId) || !_sessionManager.TryGetOtp(sessionId, out var currentOtp))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"otp_request_result\",\"ok\":false,\"message\":\"session expired\"}", cancellationToken);
                        continue;
                    }

                    var otpSent = false;
                    if (_telegramClient.IsConfigured)
                    {
                        otpSent = await _telegramClient.SendOtpAsync(currentOtp, cancellationToken);
                    }

                    if (!otpSent && _config.EnableLocalOtpFallback)
                    {
                        Console.WriteLine($"[otp] local fallback otp={currentOtp} session={sessionId}");
                        otpSent = true;
                    }

                    var otpResultMessage = otpSent
                        ? "OTP를 발송했습니다."
                        : "OTP 발송에 실패했습니다. Telegram 설정을 확인하세요.";
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"otp_request_result\","
                        + $"\"ok\":{(otpSent ? "true" : "false")},"
                        + $"\"message\":\"{EscapeJson(otpResultMessage)}\""
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "auth")
                {
                    var ticket = new TrustedAuthTicket(string.Empty, DateTimeOffset.MinValue);
                    var trustedTtl = ResolveTrustedAuthTtl(message.AuthTtlHours);
                    var ok = !string.IsNullOrWhiteSpace(message.Otp)
                             && _sessionManager.Authenticate(sessionId, message.Otp, trustedTtl, out ticket);
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"auth_result\","
                        + $"\"ok\":{(ok ? "true" : "false")},"
                        + "\"resumed\":false,"
                        + $"\"authToken\":\"{EscapeJson(ok ? ticket.Token : string.Empty)}\","
                        + $"\"expiresAtUtc\":\"{EscapeJson(ok ? ticket.ExpiresAtUtc.ToString("O") : string.Empty)}\","
                        + $"\"expiresAtLocal\":\"{EscapeJson(ok ? FormatLocalDateTime(ticket.ExpiresAtUtc) : string.Empty)}\","
                        + $"\"localUtcOffset\":\"{EscapeJson(ok ? FormatUtcOffset(ticket.ExpiresAtUtc.ToLocalTime().Offset) : string.Empty)}\","
                        + $"\"ttlHours\":{(int)Math.Round(trustedTtl.TotalHours)}"
                        + "}",
                        cancellationToken
                    );

                    if (ok)
                    {
                        await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                        await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                        await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                        if (streamTask == null)
                        {
                            streamTask = StreamMetricsAsync(socket, sendLock, streamCts.Token);
                        }
                    }

                    continue;
                }

                if (message.Type == "resume_auth")
                {
                    var hasToken = !string.IsNullOrWhiteSpace(message.AuthToken);
                    var expiresAtUtc = DateTimeOffset.MinValue;
                    var resumed = hasToken
                                  && _sessionManager.TryResumeTrusted(message.AuthToken!, out expiresAtUtc)
                                  && _sessionManager.MarkAuthenticatedFromTrusted(sessionId, expiresAtUtc);

                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"auth_result\","
                        + $"\"ok\":{(resumed ? "true" : "false")},"
                        + "\"resumed\":true,"
                        + $"\"authToken\":\"{EscapeJson(resumed ? message.AuthToken ?? string.Empty : string.Empty)}\","
                        + $"\"expiresAtUtc\":\"{EscapeJson(resumed ? expiresAtUtc.ToString("O") : string.Empty)}\","
                        + $"\"expiresAtLocal\":\"{EscapeJson(resumed ? FormatLocalDateTime(expiresAtUtc) : string.Empty)}\","
                        + $"\"localUtcOffset\":\"{EscapeJson(resumed ? FormatUtcOffset(expiresAtUtc.ToLocalTime().Offset) : string.Empty)}\""
                        + "}",
                        cancellationToken
                    );

                    if (resumed)
                    {
                        await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                        await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                        await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                        if (streamTask == null)
                        {
                            streamTask = StreamMetricsAsync(socket, sendLock, streamCts.Token);
                        }
                    }

                    continue;
                }

                if (message.Type == "get_settings" || message.Type == "get_setup_state")
                {
                    await SendSettingsStateAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "set_telegram_credentials")
                {
                    var result = _commandService.UpdateTelegramCredentials(message.TelegramBotToken, message.TelegramChatId, message.Persist);
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"settings_result\",\"ok\":true,\"message\":\"{EscapeJson(result)}\"}}", cancellationToken);
                    await SendSettingsStateAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "delete_telegram_credentials")
                {
                    var result = _commandService.DeleteTelegramCredentials(message.Persist);
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"settings_result\",\"ok\":true,\"message\":\"{EscapeJson(result)}\"}}", cancellationToken);
                    await SendSettingsStateAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "set_llm_credentials")
                {
                    var result = _commandService.UpdateLlmCredentials(
                        message.GroqApiKey,
                        message.GeminiApiKey,
                        message.CerebrasApiKey,
                        message.Persist
                    );
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"settings_result\",\"ok\":true,\"message\":\"{EscapeJson(result)}\"}}", cancellationToken);
                    await SendSettingsStateAsync(socket, sendLock, cancellationToken);
                    await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                    await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                    await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "delete_llm_credentials")
                {
                    var result = _commandService.DeleteLlmCredentials(message.Persist);
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"settings_result\",\"ok\":true,\"message\":\"{EscapeJson(result)}\"}}", cancellationToken);
                    await SendSettingsStateAsync(socket, sendLock, cancellationToken);
                    await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                    await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                    await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "test_telegram")
                {
                    var result = await _commandService.SendTelegramTestAsync(cancellationToken);
                    await SendTextAsync(socket, sendLock, $"{{\"type\":\"settings_result\",\"ok\":true,\"message\":\"{EscapeJson(result)}\"}}", cancellationToken);
                    continue;
                }

                if (message.Type == "get_copilot_status")
                {
                    var status = await _commandService.GetCopilotStatusAsync(cancellationToken);
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"copilot_status\","
                        + $"\"installed\":{(status.Installed ? "true" : "false")},"
                        + $"\"authenticated\":{(status.Authenticated ? "true" : "false")},"
                        + $"\"mode\":\"{EscapeJson(status.Mode)}\","
                        + $"\"detail\":\"{EscapeJson(status.Detail)}\""
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "get_usage_stats")
                {
                    await SendUsageStatsAsync(socket, sendLock, cancellationToken, forceRefresh: true);
                    continue;
                }

                if (message.Type == "list_conversations")
                {
                    await SendConversationsAsync(
                        socket,
                        sendLock,
                        message.Scope ?? "chat",
                        message.Mode ?? "single",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "create_conversation")
                {
                    var created = _commandService.CreateConversation(
                        message.Scope ?? "chat",
                        message.Mode ?? "single",
                        message.ConversationTitle,
                        message.Project,
                        message.Category,
                        message.Tags
                    );
                    await SendConversationDetailAsync(socket, sendLock, "conversation_created", created, cancellationToken);
                    await SendConversationsAsync(socket, sendLock, created.Scope, created.Mode, cancellationToken);
                    continue;
                }

                if (message.Type == "get_conversation")
                {
                    if (string.IsNullOrWhiteSpace(message.ConversationId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"conversationId is required\"}", cancellationToken);
                        continue;
                    }

                    var found = _commandService.GetConversation(message.ConversationId.Trim());
                    if (found == null)
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"conversation not found\"}", cancellationToken);
                        continue;
                    }

                    await SendConversationDetailAsync(socket, sendLock, "conversation_detail", found, cancellationToken);
                    continue;
                }

                if (message.Type == "delete_conversation")
                {
                    if (string.IsNullOrWhiteSpace(message.ConversationId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"conversationId is required\"}", cancellationToken);
                        continue;
                    }

                    var deleted = _commandService.DeleteConversation(message.ConversationId.Trim());
                    await SendTextAsync(
                        socket,
                        sendLock,
                        $"{{\"type\":\"conversation_deleted\",\"ok\":{(deleted ? "true" : "false")},\"conversationId\":\"{EscapeJson(message.ConversationId.Trim())}\"}}",
                        cancellationToken
                    );
                    await SendConversationsAsync(socket, sendLock, message.Scope ?? "chat", message.Mode ?? "single", cancellationToken);
                    await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "clear_memory")
                {
                    var requestedScope = string.IsNullOrWhiteSpace(message.Scope)
                        ? "chat"
                        : message.Scope.Trim().ToLowerInvariant();
                    var result = _commandService.ClearMemory(requestedScope, "web");
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"memory_cleared\","
                        + "\"ok\":true,"
                        + $"\"scope\":\"{EscapeJson(requestedScope)}\","
                        + $"\"message\":\"{EscapeJson(result)}\""
                        + "}",
                        cancellationToken
                    );

                    var refreshScope = requestedScope == "telegram" ? "chat" : requestedScope;
                    if (refreshScope == "all")
                    {
                        foreach (var targetScope in new[] { "chat", "coding" })
                        {
                            foreach (var targetMode in new[] { "single", "orchestration", "multi" })
                            {
                                await SendConversationsAsync(socket, sendLock, targetScope, targetMode, cancellationToken);
                            }
                        }
                    }
                    else if (refreshScope == "chat" || refreshScope == "coding")
                    {
                        foreach (var targetMode in new[] { "single", "orchestration", "multi" })
                        {
                            await SendConversationsAsync(socket, sendLock, refreshScope, targetMode, cancellationToken);
                        }
                    }

                    await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "list_memory_notes")
                {
                    await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "read_memory_note")
                {
                    if (string.IsNullOrWhiteSpace(message.NoteName))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"note name is required\"}", cancellationToken);
                        continue;
                    }

                    var note = _commandService.ReadMemoryNote(message.NoteName.Trim());
                    if (note == null)
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"note not found\"}", cancellationToken);
                        continue;
                    }

                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"memory_note_content\","
                        + $"\"name\":\"{EscapeJson(note.Name)}\","
                        + $"\"fullPath\":\"{EscapeJson(note.FullPath)}\","
                        + $"\"content\":\"{EscapeJson(note.Content)}\""
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "delete_memory_notes")
                {
                    var deleted = _commandService.DeleteMemoryNotes(message.MemoryNotes);
                    var removedNamesJson = string.Join(
                        ",",
                        deleted.RemovedNames.Select(name => $"\"{EscapeJson(name)}\"")
                    );
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"memory_note_deleted\","
                        + $"\"ok\":{(deleted.Ok ? "true" : "false")},"
                        + $"\"message\":\"{EscapeJson(deleted.Message)}\","
                        + $"\"requested\":{deleted.Requested},"
                        + $"\"removed\":{deleted.Removed},"
                        + $"\"unlinkedConversations\":{deleted.UnlinkedConversations},"
                        + $"\"removedNames\":[{removedNamesJson}]"
                        + "}",
                        cancellationToken
                    );
                    await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "create_memory_note")
                {
                    if (string.IsNullOrWhiteSpace(message.ConversationId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"conversationId is required\"}", cancellationToken);
                        continue;
                    }

                    var compactConversation = message.CompactConversation ?? false;
                    var created = await _commandService.CreateMemoryNoteAsync(
                        message.ConversationId.Trim(),
                        "web",
                        compactConversation,
                        cancellationToken
                    );
                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"memory_note_created\","
                        + $"\"ok\":{(created.Ok ? "true" : "false")},"
                        + $"\"conversationId\":\"{EscapeJson(message.ConversationId.Trim())}\","
                        + $"\"compact\":{(compactConversation ? "true" : "false")},"
                        + $"\"message\":\"{EscapeJson(created.Message)}\","
                        + $"\"note\":{BuildMemoryNoteJson(created.Note)}"
                        + "}",
                        cancellationToken
                    );

                    if (created.Ok && created.Conversation != null)
                    {
                        await SendConversationDetailAsync(socket, sendLock, "conversation_detail", created.Conversation, cancellationToken);
                        await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    }

                    continue;
                }

                if (message.Type == "start_copilot_login")
                {
                    var result = await _commandService.StartCopilotLoginAsync(cancellationToken);
                    await SendTextAsync(
                        socket,
                        sendLock,
                        $"{{\"type\":\"copilot_login_result\",\"message\":\"{EscapeJson(result)}\"}}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "get_copilot_models")
                {
                    await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "set_copilot_model")
                {
                    if (string.IsNullOrWhiteSpace(message.Model))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"model is required\"}", cancellationToken);
                        continue;
                    }

                    var models = await _commandService.GetCopilotModelsAsync(cancellationToken);
                    var requestedModel = message.Model.Trim();
                    if (!models.Any(x => x.Id.Equals(requestedModel, StringComparison.OrdinalIgnoreCase)))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unknown copilot model\"}", cancellationToken);
                        continue;
                    }

                    if (!_commandService.TrySetSelectedCopilotModel(requestedModel))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"invalid model id\"}", cancellationToken);
                        continue;
                    }

                    await SendTextAsync(
                        socket,
                        sendLock,
                        $"{{\"type\":\"copilot_model_set\",\"ok\":true,\"model\":\"{EscapeJson(requestedModel)}\"}}",
                        cancellationToken
                    );
                    await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "get_groq_models")
                {
                    await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "set_groq_model")
                {
                    if (string.IsNullOrWhiteSpace(message.Model))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"model is required\"}", cancellationToken);
                        continue;
                    }

                    var models = await _groqModelCatalog.GetModelsAsync(cancellationToken);
                    var requestedModel = message.Model.Trim();
                    if (!models.Any(x => x.Id.Equals(requestedModel, StringComparison.OrdinalIgnoreCase)))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unknown model\"}", cancellationToken);
                        continue;
                    }

                    if (!_llmRouter.TrySetSelectedGroqModel(requestedModel))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"invalid model id\"}", cancellationToken);
                        continue;
                    }

                    await SendTextAsync(
                        socket,
                        sendLock,
                        $"{{\"type\":\"groq_model_set\",\"ok\":true,\"model\":\"{EscapeJson(requestedModel)}\"}}",
                        cancellationToken
                    );
                    await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (!_sessionManager.IsAuthenticated(sessionId))
                {
                    await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unauthorized\"}", cancellationToken);
                    continue;
                }

                if (message.Type == GuardAlertDispatchMessageType)
                {
                    var guardAlertEventJson = BuildGuardAlertEventJson(message.RawJson);
                    if (string.IsNullOrWhiteSpace(guardAlertEventJson))
                    {
                        await SendTextAsync(
                            socket,
                            sendLock,
                            "{"
                            + $"\"type\":\"{GuardAlertDispatchResultType}\","
                            + "\"ok\":false,"
                            + "\"status\":\"invalid_payload\","
                            + "\"message\":\"guardAlertEvent object is required\","
                            + $"\"schemaVersion\":\"{GuardAlertSchemaVersion}\","
                            + $"\"eventType\":\"{GuardAlertEventType}\","
                            + $"\"attemptedAtUtc\":\"{EscapeJson(DateTimeOffset.UtcNow.ToString("O"))}\","
                            + "\"targets\":[]"
                            + "}",
                            cancellationToken
                        );
                        continue;
                    }

                    var dispatchResult = await DispatchGuardAlertEventAsync(guardAlertEventJson, cancellationToken);
                    await SendTextAsync(
                        socket,
                        sendLock,
                        BuildGuardAlertDispatchResultJson(dispatchResult),
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "sessions_list")
                {
                    var result = _commandService.ListSessions(
                        message.Kinds,
                        message.Limit,
                        message.ActiveMinutes,
                        message.MessageLimit,
                        message.Search,
                        message.Scope,
                        message.Mode
                    );
                    await SendSessionsListResultAsync(
                        socket,
                        sendLock,
                        message.Kinds,
                        message.Limit,
                        message.ActiveMinutes,
                        message.MessageLimit,
                        message.Search,
                        message.Scope,
                        message.Mode,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "sessions_history")
                {
                    var result = _commandService.GetSessionHistory(
                        message.SessionKey,
                        message.Limit,
                        message.IncludeTools ?? false
                    );
                    await SendSessionsHistoryResultAsync(
                        socket,
                        sendLock,
                        message.SessionKey,
                        message.Limit,
                        message.IncludeTools,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "sessions_send")
                {
                    var outboundMessage = string.IsNullOrWhiteSpace(message.Message)
                        ? message.Text
                        : message.Message;
                    if (string.IsNullOrWhiteSpace(outboundMessage))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"message is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.SendToSession(
                        message.SessionKey,
                        outboundMessage.Trim(),
                        message.TimeoutSeconds
                    );
                    await SendSessionsSendResultAsync(
                        socket,
                        sendLock,
                        message.SessionKey,
                        message.TimeoutSeconds,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "sessions_spawn")
                {
                    var requestedTask = string.IsNullOrWhiteSpace(message.SpawnTask)
                        ? (string.IsNullOrWhiteSpace(message.Text) ? message.Message : message.Text)
                        : message.SpawnTask;
                    if (string.IsNullOrWhiteSpace(requestedTask))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"task is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.SpawnSession(
                        requestedTask.Trim(),
                        message.Label,
                        message.Runtime,
                        message.RunTimeoutSeconds,
                        message.TimeoutSeconds,
                        message.Thread,
                        message.Mode
                    );
                    await SendSessionsSpawnResultAsync(
                        socket,
                        sendLock,
                        requestedTask.Trim(),
                        message.Label,
                        message.Runtime,
                        message.RunTimeoutSeconds,
                        message.TimeoutSeconds,
                        message.Thread,
                        message.Mode,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "cron")
                {
                    var action = (message.Action ?? string.Empty).Trim().ToLowerInvariant();
                    if (string.IsNullOrWhiteSpace(action))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"cron action is required\"}", cancellationToken);
                        continue;
                    }

                    if (action == "status")
                    {
                        var result = _commandService.GetCronStatus();
                        await SendCronStatusResultAsync(socket, sendLock, result, cancellationToken);
                        continue;
                    }

                    if (action == "list")
                    {
                        var includeDisabled = message.IncludeDisabled ?? false;
                        var result = _commandService.ListCronJobs(
                            includeDisabled,
                            message.Limit,
                            message.Offset
                        );
                        await SendCronListResultAsync(
                            socket,
                            sendLock,
                            includeDisabled,
                            message.Limit,
                            message.Offset,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    if (action == "add")
                    {
                        var rawJobJson = BuildCronAddJobJson(message.RawJson);
                        var result = _commandService.AddCronJob(rawJobJson);
                        await SendCronAddResultAsync(
                            socket,
                            sendLock,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    var requestedJobId = string.IsNullOrWhiteSpace(message.JobId)
                        ? message.CronId
                        : message.JobId;

                    if (action == "update")
                    {
                        if (string.IsNullOrWhiteSpace(requestedJobId))
                        {
                            await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"jobId is required\"}", cancellationToken);
                            continue;
                        }

                        var rawPatchJson = BuildCronUpdatePatchJson(message.RawJson);
                        var result = _commandService.UpdateCronJob(requestedJobId, rawPatchJson);
                        await SendCronUpdateResultAsync(
                            socket,
                            sendLock,
                            requestedJobId,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    if (action == "run")
                    {
                        if (string.IsNullOrWhiteSpace(requestedJobId))
                        {
                            await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"jobId is required\"}", cancellationToken);
                            continue;
                        }

                        var result = await _commandService.RunCronJobAsync(
                            requestedJobId,
                            message.RunMode,
                            "web",
                            cancellationToken
                        );
                        await SendCronRunResultAsync(
                            socket,
                            sendLock,
                            requestedJobId,
                            message.RunMode,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    if (action == "remove")
                    {
                        if (string.IsNullOrWhiteSpace(requestedJobId))
                        {
                            await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"jobId is required\"}", cancellationToken);
                            continue;
                        }

                        var result = _commandService.RemoveCronJob(requestedJobId);
                        await SendCronRemoveResultAsync(
                            socket,
                            sendLock,
                            requestedJobId,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    if (action == "runs")
                    {
                        if (string.IsNullOrWhiteSpace(requestedJobId))
                        {
                            await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"jobId is required\"}", cancellationToken);
                            continue;
                        }

                        var result = _commandService.ListCronRuns(
                            requestedJobId,
                            message.Limit,
                            message.Offset
                        );
                        await SendCronRunsResultAsync(
                            socket,
                            sendLock,
                            requestedJobId,
                            message.Limit,
                            message.Offset,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    if (action == "wake")
                    {
                        var wakeText = string.IsNullOrWhiteSpace(message.Text)
                            ? message.Message
                            : message.Text;
                        var wakeTextLength = string.IsNullOrWhiteSpace(wakeText)
                            ? 0
                            : wakeText.Trim().Length;
                        var result = _commandService.WakeCron(
                            message.Mode,
                            wakeText,
                            "web"
                        );
                        await SendCronWakeResultAsync(
                            socket,
                            sendLock,
                            message.Mode,
                            wakeTextLength,
                            result,
                            cancellationToken
                        );
                        continue;
                    }

                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"error\","
                        + $"\"message\":\"{EscapeJson($"unsupported cron action: {action}")}\""
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "browser")
                {
                    var action = (message.Action ?? string.Empty).Trim();
                    if (string.IsNullOrWhiteSpace(action))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"browser action is required\"}", cancellationToken);
                        continue;
                    }

                    var requestedUrl = string.IsNullOrWhiteSpace(message.WebFetchUrl)
                        ? (string.IsNullOrWhiteSpace(message.Query) ? null : message.Query.Trim())
                        : message.WebFetchUrl.Trim();

                    var result = _commandService.ExecuteBrowser(
                        action,
                        requestedUrl,
                        message.Profile,
                        message.TargetId,
                        message.Limit
                    );
                    await SendBrowserResultAsync(
                        socket,
                        sendLock,
                        action,
                        requestedUrl,
                        message.Profile,
                        message.TargetId,
                        message.Limit,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "canvas")
                {
                    var action = (message.Action ?? string.Empty).Trim();
                    if (string.IsNullOrWhiteSpace(action))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"canvas action is required\"}", cancellationToken);
                        continue;
                    }

                    var requestedTarget = string.IsNullOrWhiteSpace(message.Target)
                        ? (string.IsNullOrWhiteSpace(message.Search) ? null : message.Search.Trim())
                        : message.Target.Trim();
                    var requestedUrl = string.IsNullOrWhiteSpace(message.WebFetchUrl)
                        ? (string.IsNullOrWhiteSpace(message.Query) ? null : message.Query.Trim())
                        : message.WebFetchUrl.Trim();
                    var requestedTextPayload = string.IsNullOrWhiteSpace(message.Text)
                        ? message.Message
                        : message.Text;

                    var result = _commandService.ExecuteCanvas(
                        action,
                        message.Profile,
                        requestedTarget,
                        requestedUrl,
                        requestedTextPayload,
                        requestedTextPayload,
                        message.OutputFormat,
                        message.MaxWidth
                    );
                    await SendCanvasResultAsync(
                        socket,
                        sendLock,
                        action,
                        requestedTarget,
                        requestedUrl,
                        message.Profile,
                        message.OutputFormat,
                        message.MaxWidth,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "nodes")
                {
                    var action = (message.Action ?? string.Empty).Trim();
                    if (string.IsNullOrWhiteSpace(action))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"nodes action is required\"}", cancellationToken);
                        continue;
                    }

                    var requestedNode = string.IsNullOrWhiteSpace(message.Node)
                        ? (string.IsNullOrWhiteSpace(message.Target) ? null : message.Target.Trim())
                        : message.Node.Trim();
                    var requestedRequestId = string.IsNullOrWhiteSpace(message.RequestId)
                        ? null
                        : message.RequestId.Trim();
                    var requestedTitle = string.IsNullOrWhiteSpace(message.Title)
                        ? null
                        : message.Title.Trim();
                    var requestedBody = string.IsNullOrWhiteSpace(message.Body)
                        ? null
                        : message.Body.Trim();
                    var requestedPriority = string.IsNullOrWhiteSpace(message.Priority)
                        ? null
                        : message.Priority.Trim();
                    var requestedDelivery = string.IsNullOrWhiteSpace(message.Delivery)
                        ? null
                        : message.Delivery.Trim();
                    var requestedInvokeCommand = string.IsNullOrWhiteSpace(message.InvokeCommand)
                        ? null
                        : message.InvokeCommand.Trim();
                    var requestedInvokeParamsJson = string.IsNullOrWhiteSpace(message.InvokeParamsJson)
                        ? null
                        : message.InvokeParamsJson.Trim();

                    var result = _commandService.ExecuteNodes(
                        action,
                        message.Profile,
                        requestedNode,
                        requestedRequestId,
                        requestedTitle,
                        requestedBody,
                        requestedPriority,
                        requestedDelivery,
                        requestedInvokeCommand,
                        requestedInvokeParamsJson
                    );
                    await SendNodesResultAsync(
                        socket,
                        sendLock,
                        action,
                        requestedNode,
                        requestedRequestId,
                        message.Profile,
                        requestedInvokeCommand,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "telegram_stub_command")
                {
                    var requestedText = string.IsNullOrWhiteSpace(message.Text)
                        ? message.Message
                        : message.Text;
                    if (string.IsNullOrWhiteSpace(requestedText))
                    {
                        await SendTelegramStubResultAsync(
                            socket,
                            sendLock,
                            string.Empty,
                            string.Empty,
                            false,
                            "invalid",
                            "text is required",
                            cancellationToken
                        );
                        continue;
                    }

                    if (!AllowCommand(sessionId))
                    {
                        await SendTelegramStubResultAsync(
                            socket,
                            sendLock,
                            requestedText.Trim(),
                            string.Empty,
                            false,
                            "rate_limited",
                            "rate limit exceeded",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var response = await _commandService.ExecuteAsync(
                            requestedText.Trim(),
                            "telegram",
                            cancellationToken,
                            message.Attachments,
                            message.WebUrls,
                            message.WebSearchEnabled
                        );
                        var telegramExecutionMeta = _commandService.GetCurrentTelegramExecutionMetadata();
                        var isError = response.StartsWith("error:", StringComparison.OrdinalIgnoreCase);
                        await SendTelegramStubResultAsync(
                            socket,
                            sendLock,
                            requestedText.Trim(),
                            response,
                            !isError,
                            isError ? "error" : "ok",
                            isError ? response : null,
                            cancellationToken,
                            guardFailure: telegramExecutionMeta.GuardFailure,
                            retryAttempt: telegramExecutionMeta.RetryAttempt,
                            retryMaxAttempts: telegramExecutionMeta.RetryMaxAttempts,
                            retryStopReason: telegramExecutionMeta.RetryStopReason
                        );
                    }
                    catch (Exception ex)
                    {
                        await SendTelegramStubResultAsync(
                            socket,
                            sendLock,
                            requestedText.Trim(),
                            string.Empty,
                            false,
                            "error",
                            "telegram_stub_command failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "web_search")
                {
                    var query = string.IsNullOrWhiteSpace(message.Query)
                        ? message.Text
                        : message.Query;
                    if (string.IsNullOrWhiteSpace(query))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"query is required\"}", cancellationToken);
                        continue;
                    }

                    var result = await _commandService.SearchWebAsync(
                        query.Trim(),
                        message.Count,
                        message.Freshness,
                        cancellationToken
                    );
                    await SendWebSearchResultAsync(
                        socket,
                        sendLock,
                        query.Trim(),
                        message.Count,
                        message.Freshness,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "web_fetch")
                {
                    var requestedUrl = string.IsNullOrWhiteSpace(message.WebFetchUrl)
                        ? (string.IsNullOrWhiteSpace(message.Query) ? message.Text : message.Query)
                        : message.WebFetchUrl;
                    if (string.IsNullOrWhiteSpace(requestedUrl))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"url is required\"}", cancellationToken);
                        continue;
                    }

                    var result = await _commandService.FetchWebAsync(
                        requestedUrl.Trim(),
                        message.ExtractMode,
                        message.MaxChars,
                        cancellationToken
                    );
                    await SendWebFetchResultAsync(
                        socket,
                        sendLock,
                        requestedUrl.Trim(),
                        message.ExtractMode,
                        message.MaxChars,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "memory_search")
                {
                    var query = string.IsNullOrWhiteSpace(message.Query)
                        ? message.Text
                        : message.Query;
                    if (string.IsNullOrWhiteSpace(query))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"query is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.SearchMemory(
                        query.Trim(),
                        message.MaxResults,
                        message.MinScore
                    );
                    await SendMemorySearchResultAsync(socket, sendLock, query.Trim(), result, cancellationToken);
                    continue;
                }

                if (message.Type == "memory_get")
                {
                    var requestedPath = message.MemoryPath;
                    if (string.IsNullOrWhiteSpace(requestedPath))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"path is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.GetMemory(
                        requestedPath.Trim(),
                        message.FromLine,
                        message.Lines
                    );
                    await SendMemoryGetResultAsync(
                        socket,
                        sendLock,
                        requestedPath.Trim(),
                        message.FromLine,
                        message.Lines,
                        result,
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "update_conversation_meta")
                {
                    if (string.IsNullOrWhiteSpace(message.ConversationId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"conversationId is required\"}", cancellationToken);
                        continue;
                    }

                    try
                    {
                        var updated = _commandService.UpdateConversationMetadata(
                            message.ConversationId.Trim(),
                            message.ConversationTitle,
                            message.Project,
                            message.Category,
                            message.Tags
                        );
                        await SendConversationDetailAsync(socket, sendLock, "conversation_detail", updated, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, updated.Scope, updated.Mode, cancellationToken);
                        await SendMemoryNotesAsync(socket, sendLock, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendTextAsync(socket, sendLock, $"{{\"type\":\"error\",\"message\":\"{EscapeJson(ex.Message)}\"}}", cancellationToken);
                    }

                    continue;
                }

                if (message.Type == "read_workspace_file")
                {
                    if (string.IsNullOrWhiteSpace(message.FilePath))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"filePath is required\"}", cancellationToken);
                        continue;
                    }

                    var preview = _commandService.ReadWorkspaceFile(message.FilePath.Trim());
                    if (preview == null)
                    {
                        await SendTextAsync(
                            socket,
                            sendLock,
                            "{"
                            + "\"type\":\"workspace_file_preview\","
                            + "\"ok\":false,"
                            + $"\"conversationId\":\"{EscapeJson(message.ConversationId ?? string.Empty)}\","
                            + $"\"path\":\"{EscapeJson(message.FilePath.Trim())}\","
                            + "\"message\":\"파일을 읽을 수 없습니다. 경로/권한을 확인하세요.\""
                            + "}",
                            cancellationToken
                        );
                        continue;
                    }

                    await SendTextAsync(
                        socket,
                        sendLock,
                        "{"
                        + "\"type\":\"workspace_file_preview\","
                        + "\"ok\":true,"
                        + $"\"conversationId\":\"{EscapeJson(message.ConversationId ?? string.Empty)}\","
                        + $"\"path\":\"{EscapeJson(preview.FullPath)}\","
                        + $"\"content\":\"{EscapeJson(preview.Content)}\""
                        + "}",
                        cancellationToken
                    );
                    continue;
                }

                if (message.Type == "get_routines")
                {
                    await SendRoutinesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "create_routine")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routine request is required\"}", cancellationToken);
                        continue;
                    }

                    var result = await _commandService.CreateRoutineAsync(message.Text.Trim(), "web", cancellationToken);
                    await SendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
                    await SendRoutinesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "run_routine")
                {
                    if (string.IsNullOrWhiteSpace(message.RoutineId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                        continue;
                    }

                    var result = await _commandService.RunRoutineNowAsync(message.RoutineId.Trim(), "web", cancellationToken);
                    await SendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
                    await SendRoutinesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "toggle_routine")
                {
                    if (string.IsNullOrWhiteSpace(message.RoutineId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                        continue;
                    }

                    if (message.Enabled == null)
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"enabled is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.SetRoutineEnabled(message.RoutineId.Trim(), message.Enabled.Value);
                    await SendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
                    await SendRoutinesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "delete_routine")
                {
                    if (string.IsNullOrWhiteSpace(message.RoutineId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                        continue;
                    }

                    var result = _commandService.DeleteRoutine(message.RoutineId.Trim());
                    await SendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
                    await SendRoutinesAsync(socket, sendLock, cancellationToken);
                    continue;
                }

                if (message.Type == "llm_chat_single")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "empty message",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var scopeValue = message.Scope ?? "chat";
                        var modeValue = message.Mode ?? "single";
                        Action<ChatStreamUpdate> stream = update =>
                        {
                            try
                            {
                                SendChatStreamChunkAsync(socket, sendLock, update, cancellationToken).GetAwaiter().GetResult();
                            }
                            catch
                            {
                            }
                        };
                        var result = await _commandService.ChatSingleWithStateAsync(
                            new ChatRequest(
                                message.Text,
                                "web",
                                scopeValue,
                                modeValue,
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.Provider,
                                message.Model,
                                message.MemoryNotes,
                                null,
                                null,
                                null,
                                null,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken,
                            stream
                        );

                        await SendChatResultAsync(socket, sendLock, result, cancellationToken);
                        await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                        await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                        await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, message.Scope ?? "chat", message.Mode ?? "single", cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "chat_single failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "llm_chat_orchestration")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "empty message",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var result = await _commandService.ChatOrchestrationWithStateAsync(
                            new ChatRequest(
                                message.Text,
                                "web",
                                message.Scope ?? "chat",
                                message.Mode ?? "orchestration",
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.Provider,
                                message.Model,
                                message.MemoryNotes,
                                message.GroqModel,
                                message.GeminiModel,
                                message.CopilotModel,
                                message.CerebrasModel,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken
                        );
                        await SendChatResultAsync(socket, sendLock, result, cancellationToken);
                        await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, message.Scope ?? "chat", message.Mode ?? "orchestration", cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "chat_orchestration failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "llm_chat_multi")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "empty message",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var result = await _commandService.ChatMultiWithStateAsync(
                            new MultiChatRequest(
                                message.Text,
                                "web",
                                message.Scope ?? "chat",
                                message.Mode ?? "multi",
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.GroqModel,
                                message.GeminiModel,
                                message.CopilotModel,
                                message.CerebrasModel,
                                message.SummaryProvider,
                                message.MemoryNotes,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken
                        );

                        await SendTextAsync(
                            socket,
                            sendLock,
                            BuildMultiChatResultJson(result),
                            cancellationToken
                        );
                        await SendGroqModelsAsync(socket, sendLock, cancellationToken);
                        await SendCopilotModelsAsync(socket, sendLock, cancellationToken);
                        await SendUsageStatsAsync(socket, sendLock, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, message.Scope ?? "chat", message.Mode ?? "multi", cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "chat_multi failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "coding_run_single")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "empty coding input",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var scopeValue = message.Scope ?? "coding";
                        var modeValue = message.Mode ?? "single";
                        Action<CodingProgressUpdate> progress = update =>
                        {
                            _ = SendCodingProgressAsync(socket, sendLock, scopeValue, modeValue, update, cancellationToken);
                        };
                        var result = await _commandService.RunCodingSingleAsync(
                            new CodingRunRequest(
                                message.Text,
                                "web",
                                scopeValue,
                                modeValue,
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.Provider,
                                message.Model,
                                message.Language ?? "auto",
                                message.MemoryNotes,
                                null,
                                null,
                                null,
                                null,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken,
                            progress
                        );
                        await SendCodingResultAsync(socket, sendLock, result, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, scopeValue, modeValue, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "coding_single failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "coding_run_orchestration")
                {
                    try
                    {
                        var scopeValue = message.Scope ?? "coding";
                        var modeValue = message.Mode ?? "orchestration";
                        Action<CodingProgressUpdate> progress = update =>
                        {
                            _ = SendCodingProgressAsync(socket, sendLock, scopeValue, modeValue, update, cancellationToken);
                        };
                        var result = await _commandService.RunCodingOrchestrationAsync(
                            new CodingRunRequest(
                                message.Text ?? string.Empty,
                                "web",
                                scopeValue,
                                modeValue,
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.Provider,
                                message.Model,
                                message.Language ?? "auto",
                                message.MemoryNotes,
                                message.GroqModel,
                                message.GeminiModel,
                                message.CerebrasModel,
                                message.CopilotModel,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken,
                            progress
                        );
                        await SendCodingResultAsync(socket, sendLock, result, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, scopeValue, modeValue, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "coding_orchestration failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "coding_run_multi")
                {
                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "empty coding input",
                            cancellationToken
                        );
                        continue;
                    }

                    try
                    {
                        var scopeValue = message.Scope ?? "coding";
                        var modeValue = message.Mode ?? "multi";
                        Action<CodingProgressUpdate> progress = update =>
                        {
                            _ = SendCodingProgressAsync(socket, sendLock, scopeValue, modeValue, update, cancellationToken);
                        };
                        var result = await _commandService.RunCodingMultiAsync(
                            new CodingRunRequest(
                                message.Text,
                                "web",
                                scopeValue,
                                modeValue,
                                message.ConversationId,
                                message.ConversationTitle,
                                message.Project,
                                message.Category,
                                message.Tags,
                                message.Provider,
                                message.Model,
                                message.Language ?? "auto",
                                message.MemoryNotes,
                                message.GroqModel,
                                message.GeminiModel,
                                message.CerebrasModel,
                                message.CopilotModel,
                                message.Attachments,
                                message.WebUrls,
                                message.WebSearchEnabled
                            ),
                            cancellationToken,
                            progress
                        );
                        await SendCodingResultAsync(socket, sendLock, result, cancellationToken);
                        await SendConversationsAsync(socket, sendLock, scopeValue, modeValue, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        await SendGuardedErrorAsync(
                            socket,
                            sendLock,
                            "coding_multi failed: " + ex.Message,
                            cancellationToken
                        );
                    }
                    continue;
                }

                if (message.Type == "get_metrics")
                {
                    var metricsRaw = await _commandService.GetMetricsAsync(cancellationToken);
                    await SendMetricsAsync(socket, sendLock, "metrics", metricsRaw, cancellationToken);
                    continue;
                }

                if (message.Type == "command")
                {
                    if (!AllowCommand(sessionId))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"rate limit exceeded\"}", cancellationToken);
                        continue;
                    }

                    if (string.IsNullOrWhiteSpace(message.Text))
                    {
                        await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"empty command\"}", cancellationToken);
                        continue;
                    }

                    var result = await _commandService.ExecuteAsync(
                        message.Text.Trim(),
                        "web",
                        cancellationToken,
                        message.Attachments,
                        message.WebUrls,
                        message.WebSearchEnabled
                    );
                    await SendTextAsync(
                        socket,
                        sendLock,
                        $"{{\"type\":\"command_result\",\"text\":\"{EscapeJson(result)}\"}}",
                        cancellationToken
                    );
                    continue;
                }

                await SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unsupported message type\"}", cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ws] client error: {ex.Message}");
        }
        finally
        {
            streamCts.Cancel();
            if (streamTask != null)
            {
                try
                {
                    await streamTask;
                }
                catch
                {
                }
            }

            if (sessionId != null)
            {
                _sessionManager.Remove(sessionId);
                ClearRateWindow(sessionId);
            }

            if (socket != null && socket.State != WebSocketState.Closed && socket.State != WebSocketState.Aborted)
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                }
                catch
                {
                }
            }

            socket?.Dispose();
            sendLock.Dispose();
            streamCts.Dispose();
        }
    }

    private async Task StreamMetricsAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, _config.MetricsPushIntervalSec));
        var warnedCoreUnavailable = false;
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            try
            {
                var metricsRaw = await _commandService.GetMetricsAsync(cancellationToken);
                await SendMetricsAsync(socket, sendLock, "metrics_stream", metricsRaw, cancellationToken);
                warnedCoreUnavailable = false;
                await Task.Delay(interval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                var message = ex.Message ?? string.Empty;
                var isConnectionRefused = message.IndexOf("Connection refused", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!isConnectionRefused || !warnedCoreUnavailable)
                {
                    Console.Error.WriteLine($"[ws] metrics stream error: {message}");
                }

                warnedCoreUnavailable = warnedCoreUnavailable || isConnectionRefused;
                var delay = isConnectionRefused
                    ? TimeSpan.FromSeconds(Math.Max(3, _config.MetricsPushIntervalSec))
                    : TimeSpan.FromSeconds(1);
                await Task.Delay(delay, cancellationToken);
            }
        }
    }

    private async Task SendSettingsStateAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var snapshot = _commandService.GetSettingsSnapshot();
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"settings_state\","
            + $"\"telegramBotTokenSet\":{(snapshot.TelegramBotTokenSet ? "true" : "false")},"
            + $"\"telegramChatIdSet\":{(snapshot.TelegramChatIdSet ? "true" : "false")},"
            + $"\"groqApiKeySet\":{(snapshot.GroqApiKeySet ? "true" : "false")},"
            + $"\"geminiApiKeySet\":{(snapshot.GeminiApiKeySet ? "true" : "false")},"
            + $"\"cerebrasApiKeySet\":{(snapshot.CerebrasApiKeySet ? "true" : "false")},"
            + $"\"telegramBotTokenMasked\":\"{EscapeJson(snapshot.TelegramBotTokenMasked)}\","
            + $"\"telegramChatIdMasked\":\"{EscapeJson(snapshot.TelegramChatIdMasked)}\","
            + $"\"groqApiKeyMasked\":\"{EscapeJson(snapshot.GroqApiKeyMasked)}\","
            + $"\"geminiApiKeyMasked\":\"{EscapeJson(snapshot.GeminiApiKeyMasked)}\","
            + $"\"cerebrasApiKeyMasked\":\"{EscapeJson(snapshot.CerebrasApiKeyMasked)}\""
            + "}",
            cancellationToken
        );
    }

    private async Task SendGroqModelsAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var models = await _groqModelCatalog.GetModelsAsync(cancellationToken);
        var usageMap = _llmRouter.GetGroqUsageSnapshot();
        var rateMap = _llmRouter.GetGroqRateLimitSnapshot();
        var selectedModel = _llmRouter.GetSelectedGroqModel();

        var builder = new StringBuilder();
        builder.Append("{\"type\":\"groq_models\",");
        builder.Append($"\"selected\":\"{EscapeJson(selectedModel)}\",");
        builder.Append("\"items\":[");

        for (var i = 0; i < models.Count; i++)
        {
            var model = models[i];
            usageMap.TryGetValue(model.Id, out var usage);
            rateMap.TryGetValue(model.Id, out var rate);

            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"id\":\"{EscapeJson(model.Id)}\",");
            builder.Append($"\"tier\":\"{EscapeJson(model.Tier)}\",");
            builder.Append($"\"speed_tps\":\"{EscapeJson(model.SpeedTokensPerSecond)}\",");
            builder.Append($"\"rate_limit\":\"{EscapeJson(model.RateLimit)}\",");
            builder.Append($"\"rpm\":\"{EscapeJson(model.Rpm)}\",");
            builder.Append($"\"rpd\":\"{EscapeJson(model.Rpd)}\",");
            builder.Append($"\"tpm\":\"{EscapeJson(model.Tpm)}\",");
            builder.Append($"\"tpd\":\"{EscapeJson(model.Tpd)}\",");
            builder.Append($"\"ash\":\"{EscapeJson(model.Ash)}\",");
            builder.Append($"\"asd\":\"{EscapeJson(model.Asd)}\",");
            builder.Append($"\"context_window\":\"{EscapeJson(model.ContextWindow)}\",");
            builder.Append($"\"max_completion_tokens\":\"{EscapeJson(model.MaxCompletionTokens)}\",");
            builder.Append($"\"max_file_size\":\"{EscapeJson(model.MaxFileSize)}\",");
            builder.Append($"\"price_input\":\"{EscapeJson(model.PriceInputPerMillion)}\",");
            builder.Append($"\"price_output\":\"{EscapeJson(model.PriceOutputPerMillion)}\",");
            builder.Append($"\"usage_requests\":{usage?.Requests ?? 0},");
            builder.Append($"\"usage_prompt_tokens\":{usage?.PromptTokens ?? 0},");
            builder.Append($"\"usage_completion_tokens\":{usage?.CompletionTokens ?? 0},");
            builder.Append($"\"usage_total_tokens\":{usage?.TotalTokens ?? 0},");
            builder.Append($"\"limit_requests\":{(rate?.LimitRequests.HasValue == true ? rate.LimitRequests.Value.ToString() : "null")},");
            builder.Append($"\"remaining_requests\":{(rate?.RemainingRequests.HasValue == true ? rate.RemainingRequests.Value.ToString() : "null")},");
            builder.Append($"\"limit_tokens\":{(rate?.LimitTokens.HasValue == true ? rate.LimitTokens.Value.ToString() : "null")},");
            builder.Append($"\"remaining_tokens\":{(rate?.RemainingTokens.HasValue == true ? rate.RemainingTokens.Value.ToString() : "null")},");
            builder.Append($"\"reset_requests\":\"{EscapeJson(rate?.ResetRequests ?? "-")}\",");
            builder.Append($"\"reset_tokens\":\"{EscapeJson(rate?.ResetTokens ?? "-")}\"");
            builder.Append("}");
        }

        builder.Append("]}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCopilotModelsAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var models = await _commandService.GetCopilotModelsAsync(cancellationToken);
        var selectedModel = _commandService.GetSelectedCopilotModel();

        var builder = new StringBuilder();
        builder.Append("{\"type\":\"copilot_models\",");
        builder.Append($"\"selected\":\"{EscapeJson(selectedModel)}\",");
        builder.Append("\"items\":[");

        for (var i = 0; i < models.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var model = models[i];
            builder.Append("{");
            builder.Append($"\"id\":\"{EscapeJson(model.Id)}\",");
            builder.Append($"\"provider\":\"{EscapeJson(model.Provider)}\",");
            builder.Append($"\"premium_multiplier\":\"{EscapeJson(model.PremiumMultiplier)}\",");
            builder.Append($"\"speed_tps\":\"{EscapeJson(model.OutputTokensPerSecond)}\",");
            builder.Append($"\"rate_limit\":\"{EscapeJson(model.RateLimit)}\",");
            builder.Append($"\"context_window\":\"{EscapeJson(model.ContextWindow)}\",");
            builder.Append($"\"max_completion_tokens\":\"{EscapeJson(model.MaxCompletionTokens)}\",");
            builder.Append($"\"usage_requests\":{model.UsageRequests}");
            builder.Append("}");
        }

        builder.Append("]}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendUsageStatsAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken,
        bool forceRefresh = false
    )
    {
        var gemini = _commandService.GetGeminiUsageSnapshot();
        var copilotPremium = await _commandService.GetCopilotPremiumUsageSnapshotAsync(cancellationToken, forceRefresh);
        var copilotLocal = _commandService.GetCopilotLocalUsageSnapshot();
        var localItems = copilotLocal
            .OrderByDescending(x => x.Value.Requests)
            .Take(12)
            .ToArray();
        long localTotalRequests = 0;
        for (var i = 0; i < localItems.Length; i++)
        {
            localTotalRequests += localItems[i].Value.Requests;
        }

        var selectedLocalModel = _commandService.GetSelectedCopilotModel();
        var selectedLocalRequests = 0L;
        if (!string.IsNullOrWhiteSpace(selectedLocalModel)
            && copilotLocal.TryGetValue(selectedLocalModel, out var selectedUsage))
        {
            selectedLocalRequests = selectedUsage.Requests;
        }

        var premiumMessage = string.IsNullOrWhiteSpace(copilotPremium.Message)
            ? (copilotPremium.Available
                ? "Copilot Premium 사용량 조회 성공"
                : "Copilot Premium 사용량 조회 실패")
            : copilotPremium.Message;
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"usage_stats\",");
        builder.Append("\"gemini\":{");
        builder.Append($"\"requests\":{gemini.Requests},");
        builder.Append($"\"prompt_tokens\":{gemini.PromptTokens},");
        builder.Append($"\"completion_tokens\":{gemini.CompletionTokens},");
        builder.Append($"\"total_tokens\":{gemini.TotalTokens},");
        builder.Append($"\"input_price_per_million_usd\":\"{_config.GeminiInputPricePerMillionUsd.ToString("F4", CultureInfo.InvariantCulture)}\",");
        builder.Append($"\"output_price_per_million_usd\":\"{_config.GeminiOutputPricePerMillionUsd.ToString("F4", CultureInfo.InvariantCulture)}\",");
        builder.Append($"\"estimated_cost_usd\":\"{gemini.EstimatedCostUsd.ToString("F6", CultureInfo.InvariantCulture)}\"");
        builder.Append("},");
        builder.Append("\"copilotPremium\":{");
        builder.Append($"\"available\":{(copilotPremium.Available ? "true" : "false")},");
        builder.Append($"\"requires_user_scope\":{(copilotPremium.RequiresUserScope ? "true" : "false")},");
        builder.Append($"\"message\":\"{EscapeJson(premiumMessage)}\",");
        builder.Append($"\"username\":\"{EscapeJson(copilotPremium.Username)}\",");
        builder.Append($"\"plan_name\":\"{EscapeJson(copilotPremium.PlanName)}\",");
        builder.Append($"\"used_requests\":\"{copilotPremium.UsedRequests.ToString("F1", CultureInfo.InvariantCulture)}\",");
        builder.Append($"\"monthly_quota\":\"{copilotPremium.MonthlyQuota.ToString("F1", CultureInfo.InvariantCulture)}\",");
        builder.Append($"\"percent_used\":\"{copilotPremium.PercentUsed.ToString("F2", CultureInfo.InvariantCulture)}\",");
        builder.Append($"\"refreshed_local\":\"{EscapeJson(copilotPremium.RefreshedLocal)}\",");
        builder.Append($"\"features_url\":\"{EscapeJson(copilotPremium.FeaturesUrl)}\",");
        builder.Append($"\"billing_url\":\"{EscapeJson(copilotPremium.BillingUrl)}\",");
        builder.Append("\"items\":[");
        for (var i = 0; i < copilotPremium.Items.Count; i++)
        {
            var item = copilotPremium.Items[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"model\":\"{EscapeJson(item.Model)}\",");
            builder.Append($"\"requests\":\"{item.Requests.ToString("F1", CultureInfo.InvariantCulture)}\",");
            builder.Append($"\"percent\":\"{item.Percent.ToString("F2", CultureInfo.InvariantCulture)}\"");
            builder.Append("}");
        }

        builder.Append("]},");
        builder.Append("\"copilotLocal\":{");
        builder.Append($"\"selected_model\":\"{EscapeJson(selectedLocalModel)}\",");
        builder.Append($"\"selected_model_requests\":{selectedLocalRequests},");
        builder.Append($"\"total_requests\":{localTotalRequests},");
        builder.Append("\"items\":[");
        for (var i = 0; i < localItems.Length; i++)
        {
            var item = localItems[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"model\":\"{EscapeJson(item.Key)}\",");
            builder.Append($"\"requests\":{item.Value.Requests}");
            builder.Append("}");
        }

        builder.Append("]}");
        builder.Append("}");
        await SendTextAsync(
            socket,
            sendLock,
            builder.ToString(),
            cancellationToken
        );
    }

    private async Task SendConversationsAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string scope,
        string mode,
        CancellationToken cancellationToken
    )
    {
        var items = _commandService.ListConversations(scope, mode);
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"conversations\",");
        builder.Append($"\"scope\":\"{EscapeJson(scope)}\",");
        builder.Append($"\"mode\":\"{EscapeJson(mode)}\",");
        builder.Append("\"items\":[");
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"id\":\"{EscapeJson(item.Id)}\",");
            builder.Append($"\"title\":\"{EscapeJson(item.Title)}\",");
            builder.Append($"\"project\":\"{EscapeJson(item.Project)}\",");
            builder.Append($"\"category\":\"{EscapeJson(item.Category)}\",");
            builder.Append($"\"createdUtc\":\"{EscapeJson(item.CreatedUtc.ToString("O"))}\",");
            builder.Append($"\"updatedUtc\":\"{EscapeJson(item.UpdatedUtc.ToString("O"))}\",");
            builder.Append($"\"messageCount\":{item.MessageCount},");
            builder.Append($"\"preview\":\"{EscapeJson(item.Preview)}\",");
            builder.Append("\"tags\":[");
            for (var j = 0; j < item.Tags.Count; j++)
            {
                if (j > 0)
                {
                    builder.Append(",");
                }

                builder.Append($"\"{EscapeJson(item.Tags[j])}\"");
            }

            builder.Append("],");
            builder.Append("\"linkedMemoryNotes\":[");
            for (var j = 0; j < item.LinkedMemoryNotes.Count; j++)
            {
                if (j > 0)
                {
                    builder.Append(",");
                }

                builder.Append($"\"{EscapeJson(item.LinkedMemoryNotes[j])}\"");
            }

            builder.Append("]");
            builder.Append("}");
        }

        builder.Append("]}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendConversationDetailAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string type,
        ConversationThreadView conversation,
        CancellationToken cancellationToken
    )
    {
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + $"\"type\":\"{EscapeJson(type)}\","
            + $"\"conversation\":{BuildConversationJson(conversation)}"
            + "}",
            cancellationToken
        );
    }

    private async Task SendMemoryNotesAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var notes = _commandService.ListMemoryNotes();
        var builder = new StringBuilder();
        builder.Append("{\"type\":\"memory_notes\",\"items\":[");
        for (var i = 0; i < notes.Count; i++)
        {
            var item = notes[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"name\":\"{EscapeJson(item.Name)}\",");
            builder.Append($"\"fullPath\":\"{EscapeJson(item.FullPath)}\",");
            builder.Append($"\"excerpt\":\"{EscapeJson(item.Excerpt)}\",");
            builder.Append($"\"sizeBytes\":{item.SizeBytes},");
            builder.Append($"\"lastWriteUtc\":\"{EscapeJson(item.LastWriteUtc.ToString("O"))}\"");
            builder.Append("}");
        }

        builder.Append("]}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendMemorySearchResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string query,
        MemorySearchToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"memory_search_result\",");
        builder.Append($"\"query\":\"{EscapeJson(query)}\",");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        builder.Append("\"results\":[");

        for (var i = 0; i < result.Results.Count; i++)
        {
            var item = result.Results[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"path\":\"{EscapeJson(item.Path)}\",");
            builder.Append($"\"startLine\":{item.StartLine},");
            builder.Append($"\"endLine\":{item.EndLine},");
            builder.Append($"\"snippet\":\"{EscapeJson(item.Snippet)}\",");
            builder.Append($"\"score\":{item.Score.ToString("0.####", CultureInfo.InvariantCulture)},");
            builder.Append($"\"source\":\"{EscapeJson(item.Source)}\"");
            builder.Append("}");
        }

        builder.Append("]");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCanvasResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedAction,
        string? requestedTarget,
        string? requestedUrl,
        string? requestedProfile,
        string? requestedOutputFormat,
        int? requestedMaxWidth,
        CanvasToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"canvas_result\",");
        builder.Append($"\"requestedAction\":\"{EscapeJson(requestedAction)}\",");
        builder.Append($"\"action\":\"{EscapeJson(result.Action)}\",");
        builder.Append($"\"profile\":\"{EscapeJson(result.Profile)}\",");
        if (!string.IsNullOrWhiteSpace(requestedProfile))
        {
            builder.Append($"\"requestedProfile\":\"{EscapeJson(requestedProfile.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedTarget))
        {
            builder.Append($"\"requestedTarget\":\"{EscapeJson(requestedTarget)}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedUrl))
        {
            builder.Append($"\"requestedUrl\":\"{EscapeJson(requestedUrl)}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedOutputFormat))
        {
            builder.Append($"\"requestedOutputFormat\":\"{EscapeJson(requestedOutputFormat.Trim())}\",");
        }

        if (requestedMaxWidth.HasValue)
        {
            builder.Append($"\"requestedMaxWidth\":{requestedMaxWidth.Value},");
        }

        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        builder.Append($"\"adapter\":\"{EscapeJson(result.Adapter)}\",");
        builder.Append($"\"visible\":{(result.Visible ? "true" : "false")},");
        if (!string.IsNullOrWhiteSpace(result.Target))
        {
            builder.Append($"\"target\":\"{EscapeJson(result.Target)}\",");
        }

        if (!string.IsNullOrWhiteSpace(result.Url))
        {
            builder.Append($"\"url\":\"{EscapeJson(result.Url)}\",");
        }

        if (!string.IsNullOrWhiteSpace(result.EvalResult))
        {
            builder.Append($"\"evalResult\":\"{EscapeJson(result.EvalResult)}\",");
        }

        builder.Append($"\"a2uiRevision\":{result.A2UiRevision},");
        builder.Append($"\"updatedAtMs\":{result.UpdatedAtMs}");
        if (result.Snapshot is not null)
        {
            builder.Append(",\"snapshot\":{");
            builder.Append($"\"snapshotId\":\"{EscapeJson(result.Snapshot.SnapshotId)}\",");
            builder.Append($"\"format\":\"{EscapeJson(result.Snapshot.Format)}\",");
            builder.Append($"\"width\":{result.Snapshot.Width},");
            builder.Append($"\"height\":{result.Snapshot.Height},");
            builder.Append($"\"updatedAtMs\":{result.Snapshot.UpdatedAtMs}");
            builder.Append("}");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendBrowserResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedAction,
        string? requestedUrl,
        string? requestedProfile,
        string? requestedTargetId,
        int? requestedLimit,
        BrowserToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"browser_result\",");
        builder.Append($"\"requestedAction\":\"{EscapeJson(requestedAction)}\",");
        builder.Append($"\"action\":\"{EscapeJson(result.Action)}\",");
        builder.Append($"\"profile\":\"{EscapeJson(result.Profile)}\",");
        if (!string.IsNullOrWhiteSpace(requestedProfile))
        {
            builder.Append($"\"requestedProfile\":\"{EscapeJson(requestedProfile.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedUrl))
        {
            builder.Append($"\"requestedUrl\":\"{EscapeJson(requestedUrl)}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedTargetId))
        {
            builder.Append($"\"requestedTargetId\":\"{EscapeJson(requestedTargetId.Trim())}\",");
        }

        if (requestedLimit.HasValue)
        {
            builder.Append($"\"limit\":{requestedLimit.Value},");
        }

        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        builder.Append($"\"adapter\":\"{EscapeJson(result.Adapter)}\",");
        builder.Append($"\"running\":{(result.Running ? "true" : "false")},");
        if (!string.IsNullOrWhiteSpace(result.ActiveTargetId))
        {
            builder.Append($"\"activeTargetId\":\"{EscapeJson(result.ActiveTargetId)}\",");
        }

        if (!string.IsNullOrWhiteSpace(result.ActiveUrl))
        {
            builder.Append($"\"activeUrl\":\"{EscapeJson(result.ActiveUrl)}\",");
        }

        builder.Append("\"tabs\":[");
        for (var i = 0; i < result.Tabs.Count; i++)
        {
            var tab = result.Tabs[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"targetId\":\"{EscapeJson(tab.TargetId)}\",");
            builder.Append($"\"url\":\"{EscapeJson(tab.Url)}\",");
            builder.Append($"\"title\":\"{EscapeJson(tab.Title)}\",");
            builder.Append($"\"active\":{(tab.Active ? "true" : "false")},");
            builder.Append($"\"updatedAtMs\":{tab.UpdatedAtMs}");
            builder.Append("}");
        }

        builder.Append("]");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendNodesResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedAction,
        string? requestedNode,
        string? requestedRequestId,
        string? requestedProfile,
        string? requestedInvokeCommand,
        NodesToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"nodes_result\",");
        builder.Append($"\"requestedAction\":\"{EscapeJson(requestedAction)}\",");
        builder.Append($"\"action\":\"{EscapeJson(result.Action)}\",");
        builder.Append($"\"profile\":\"{EscapeJson(result.Profile)}\",");
        if (!string.IsNullOrWhiteSpace(requestedProfile))
        {
            builder.Append($"\"requestedProfile\":\"{EscapeJson(requestedProfile.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedNode))
        {
            builder.Append($"\"requestedNode\":\"{EscapeJson(requestedNode.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedRequestId))
        {
            builder.Append($"\"requestedRequestId\":\"{EscapeJson(requestedRequestId.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedInvokeCommand))
        {
            builder.Append($"\"requestedInvokeCommand\":\"{EscapeJson(requestedInvokeCommand.Trim())}\",");
        }

        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        builder.Append($"\"adapter\":\"{EscapeJson(result.Adapter)}\",");
        if (!string.IsNullOrWhiteSpace(result.SelectedNodeId))
        {
            builder.Append($"\"selectedNodeId\":\"{EscapeJson(result.SelectedNodeId)}\",");
        }

        if (!string.IsNullOrWhiteSpace(result.SelectedCommand))
        {
            builder.Append($"\"selectedCommand\":\"{EscapeJson(result.SelectedCommand)}\",");
        }

        if (!string.IsNullOrWhiteSpace(result.InvokePayloadJson))
        {
            builder.Append($"\"invokePayloadJson\":\"{EscapeJson(result.InvokePayloadJson)}\",");
        }

        builder.Append($"\"updatedAtMs\":{result.UpdatedAtMs},");
        builder.Append("\"nodes\":[");
        for (var i = 0; i < result.Nodes.Count; i++)
        {
            var node = result.Nodes[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"nodeId\":\"{EscapeJson(node.NodeId)}\",");
            builder.Append($"\"label\":\"{EscapeJson(node.Label)}\",");
            builder.Append($"\"online\":{(node.Online ? "true" : "false")},");
            builder.Append($"\"platform\":\"{EscapeJson(node.Platform)}\",");
            if (!string.IsNullOrWhiteSpace(node.LastCommand))
            {
                builder.Append($"\"lastCommand\":\"{EscapeJson(node.LastCommand)}\",");
            }

            if (node.LastCommandAtMs.HasValue)
            {
                builder.Append($"\"lastCommandAtMs\":{node.LastCommandAtMs.Value},");
            }

            builder.Append($"\"updatedAtMs\":{node.UpdatedAtMs},");
            builder.Append("\"commands\":[");
            for (var commandIndex = 0; commandIndex < node.Commands.Count; commandIndex++)
            {
                if (commandIndex > 0)
                {
                    builder.Append(",");
                }

                builder.Append($"\"{EscapeJson(node.Commands[commandIndex])}\"");
            }

            builder.Append("]");
            builder.Append("}");
        }

        builder.Append("],");
        builder.Append("\"pendingRequests\":[");
        for (var i = 0; i < result.PendingRequests.Count; i++)
        {
            var pending = result.PendingRequests[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"requestId\":\"{EscapeJson(pending.RequestId)}\",");
            builder.Append($"\"nodeLabel\":\"{EscapeJson(pending.NodeLabel)}\",");
            builder.Append($"\"status\":\"{EscapeJson(pending.Status)}\",");
            builder.Append($"\"requestedAtMs\":{pending.RequestedAtMs},");
            builder.Append($"\"updatedAtMs\":{pending.UpdatedAtMs}");
            builder.Append("}");
        }

        builder.Append("]");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendTelegramStubResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedText,
        string responseText,
        bool ok,
        string status,
        string? error,
        CancellationToken cancellationToken,
        SearchAnswerGuardFailure? guardFailure = null,
        int retryAttempt = 0,
        int retryMaxAttempts = 0,
        string retryStopReason = "-"
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"telegram_stub_result\",");
        builder.Append("\"action\":\"command\",");
        builder.Append("\"group\":\"telegram\",");
        builder.Append("\"adapter\":\"stub\",");
        builder.Append("\"channel\":\"telegram\",");
        builder.Append($"\"input\":\"{EscapeJson(requestedText)}\",");
        builder.Append($"\"ok\":{(ok ? "true" : "false")},");
        builder.Append($"\"status\":\"{EscapeJson(status)}\",");
        builder.Append($"\"response\":\"{EscapeJson(responseText)}\"");
        if (!string.IsNullOrWhiteSpace(error))
        {
            builder.Append($",\"error\":\"{EscapeJson(error)}\"");
        }

        var effectiveGuardFailure = guardFailure ?? TryParseGuardFailureFromMessage(error ?? responseText);
        var guardCategory = NormalizeWebSearchGuardCategory(effectiveGuardFailure);
        var guardReason = NormalizeWebSearchGuardReason(effectiveGuardFailure);
        var guardDetail = NormalizeWebSearchGuardDetail(effectiveGuardFailure);
        var retryDirective = ResolveRetryDirective(effectiveGuardFailure);
        var resolvedRetryAttempt = Math.Max(0, retryAttempt);
        var resolvedRetryMaxAttempts = Math.Max(0, retryMaxAttempts);
        var resolvedRetryStopReason = string.IsNullOrWhiteSpace(retryStopReason)
            ? NormalizeWebSearchGuardReason(effectiveGuardFailure)
            : retryStopReason;
        var normalizedRetryStopReason = NormalizeWebSearchRetryStopReason(resolvedRetryStopReason);
        builder.Append($",\"guardCategory\":\"{EscapeJson(guardCategory)}\"");
        builder.Append($",\"guardReason\":\"{EscapeJson(guardReason)}\"");
        builder.Append($",\"guardDetail\":\"{EscapeJson(guardDetail)}\"");
        builder.Append($",\"retryAttempt\":{resolvedRetryAttempt}");
        builder.Append($",\"retryMaxAttempts\":{resolvedRetryMaxAttempts}");
        builder.Append($",\"retryStopReason\":\"{EscapeJson(normalizedRetryStopReason)}\"");
        builder.Append($",\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")}");
        builder.Append($",\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\"");
        builder.Append($",\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\"");
        builder.Append($",\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\"");

        builder.Append("}");
        TrackGuardRetryTimelineEntry(
            channel: "telegram",
            retryRequired: retryDirective.RetryRequired,
            retryAttempt: resolvedRetryAttempt,
            retryMaxAttempts: resolvedRetryMaxAttempts,
            retryStopReason: normalizedRetryStopReason
        );
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendWebSearchResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string query,
        int? count,
        string? freshness,
        WebSearchToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"web_search_result\",");
        builder.Append($"\"query\":\"{EscapeJson(query)}\",");
        builder.Append($"\"provider\":\"{EscapeJson(result.Provider)}\",");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        if (count.HasValue)
        {
            builder.Append($"\"count\":{count.Value},");
        }

        if (!string.IsNullOrWhiteSpace(freshness))
        {
            builder.Append($"\"freshness\":\"{EscapeJson(freshness.Trim())}\",");
        }

        builder.Append("\"results\":[");
        for (var i = 0; i < result.Results.Count; i++)
        {
            var item = result.Results[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"title\":\"{EscapeJson(item.Title)}\",");
            builder.Append($"\"url\":\"{EscapeJson(item.Url)}\",");
            builder.Append($"\"description\":\"{EscapeJson(item.Description)}\",");
            builder.Append($"\"citationId\":\"{EscapeJson(NormalizeWebSearchCitationId(item.CitationId, i + 1))}\"");
            if (!string.IsNullOrWhiteSpace(item.Published))
            {
                builder.Append($",\"published\":\"{EscapeJson(item.Published)}\"");
            }

            builder.Append("}");
        }

        builder.Append("]");
        if (result.ExternalContent is not null)
        {
            builder.Append(",\"externalContent\":{");
            builder.Append($"\"untrusted\":{(result.ExternalContent.Untrusted ? "true" : "false")},");
            builder.Append($"\"source\":\"{EscapeJson(result.ExternalContent.Source)}\",");
            builder.Append($"\"provider\":\"{EscapeJson(result.ExternalContent.Provider)}\",");
            builder.Append($"\"wrapped\":{(result.ExternalContent.Wrapped ? "true" : "false")}");
            builder.Append("}");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        var guardCategory = NormalizeWebSearchGuardCategory(result.GuardFailure);
        var guardReason = NormalizeWebSearchGuardReason(result.GuardFailure);
        var guardDetail = NormalizeWebSearchGuardDetail(result.GuardFailure);
        builder.Append($",\"guardCategory\":\"{EscapeJson(guardCategory)}\"");
        builder.Append($",\"guardReason\":\"{EscapeJson(guardReason)}\"");
        builder.Append($",\"guardDetail\":\"{EscapeJson(guardDetail)}\"");
        builder.Append($",\"retryAttempt\":{Math.Max(0, result.RetryAttempt)}");
        builder.Append($",\"retryMaxAttempts\":{Math.Max(0, result.RetryMaxAttempts)}");
        builder.Append($",\"retryStopReason\":\"{EscapeJson(NormalizeWebSearchRetryStopReason(result.RetryStopReason))}\"");
        AppendRetryDirectiveJson(builder, result.GuardFailure);

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private static string NormalizeWebSearchGuardCategory(SearchAnswerGuardFailure? failure)
    {
        if (failure is null)
        {
            return "-";
        }

        var normalized = failure.Category.ToString().ToLowerInvariant();
        return normalized switch
        {
            "coverage" or "freshness" or "credibility" => normalized,
            _ => "-"
        };
    }

    private static string NormalizeWebSearchGuardReason(SearchAnswerGuardFailure? failure)
    {
        if (failure is null)
        {
            return "-";
        }

        var normalized = (failure.ReasonCode ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static string NormalizeWebSearchGuardDetail(SearchAnswerGuardFailure? failure)
    {
        if (failure is null)
        {
            return "-";
        }

        var normalized = (failure.Detail ?? string.Empty)
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return normalized.Length <= 180
            ? normalized
            : normalized[..180] + "...";
    }

    private static string NormalizeWebSearchRetryStopReason(string? stopReason)
    {
        var normalized = (stopReason ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private void TrackGuardRetryTimelineEntry(
        string channel,
        bool retryRequired,
        int retryAttempt,
        int retryMaxAttempts,
        string? retryStopReason
    )
    {
        try
        {
            _guardRetryTimelineStore.Add(
                channel: channel,
                retryRequired: retryRequired,
                retryAttempt: Math.Max(0, retryAttempt),
                retryMaxAttempts: Math.Max(0, retryMaxAttempts),
                retryStopReason: NormalizeWebSearchRetryStopReason(retryStopReason)
            );
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[guard-retry-timeline] append failed: {ex.Message}");
        }
    }

    private static void AppendRetryDirectiveJson(StringBuilder builder, SearchAnswerGuardFailure? failure)
    {
        var retryDirective = ResolveRetryDirective(failure);
        builder.Append($",\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")}");
        builder.Append($",\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\"");
        builder.Append($",\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\"");
        builder.Append($",\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\"");
    }

    private static (bool RetryRequired, string RetryAction, string RetryScope, string RetryReason) ResolveRetryDirective(
        SearchAnswerGuardFailure? failure
    )
    {
        if (failure is null)
        {
            return (false, "-", "-", "-");
        }

        var reason = NormalizeWebSearchGuardReason(failure);
        var retryAction = reason switch
        {
            "citation_validation_failed" => "retry_with_citation_mapping",
            "count_lock_unsatisfied" or "count_lock_unsatisfied_after_retries" or "target_count_mismatch" => "retry_with_recollect_loop",
            _ => failure.Category switch
            {
                SearchAnswerGuardFailureCategory.Coverage => "retry_with_recollect_loop",
                SearchAnswerGuardFailureCategory.Freshness => "retry_with_freshness_probe",
                SearchAnswerGuardFailureCategory.Credibility => "retry_with_source_expansion",
                _ => "retry_with_recollect_loop"
            }
        };

        return (
            true,
            retryAction,
            "gemini_grounding_search",
            reason
        );
    }

    private static string NormalizeWebSearchCitationId(string? citationId, int fallbackIndex)
    {
        var normalized = (citationId ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return $"c{Math.Max(1, fallbackIndex)}";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static SearchAnswerGuardFailure? TryParseGuardFailureFromMessage(string? message)
    {
        var normalized = (message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        if (normalized.Contains(CitationValidationBlockedToken, StringComparison.Ordinal))
        {
            return new SearchAnswerGuardFailure(
                SearchAnswerGuardFailureCategory.Coverage,
                "citation_validation_failed",
                "blocked_response_text_detected"
            );
        }

        var localizedFailure = TryParseLocalizedGuardFailure(normalized);
        if (localizedFailure is not null)
        {
            return localizedFailure;
        }

        var match = AnswerGuardBlockedPattern.Match(normalized);
        if (!match.Success)
        {
            return null;
        }

        var categoryRaw = match.Groups["category"].Value.Trim().ToLowerInvariant();
        var category = categoryRaw switch
        {
            "coverage" => SearchAnswerGuardFailureCategory.Coverage,
            "freshness" => SearchAnswerGuardFailureCategory.Freshness,
            "credibility" => SearchAnswerGuardFailureCategory.Credibility,
            _ => (SearchAnswerGuardFailureCategory?)null
        };
        if (category is null)
        {
            return null;
        }

        var reasonCode = match.Groups["reason"].Value.Trim();
        if (string.IsNullOrWhiteSpace(reasonCode))
        {
            reasonCode = "unknown";
        }

        var detail = match.Groups["detail"].Success
            ? match.Groups["detail"].Value.Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(detail))
        {
            detail = "-";
        }

        return new SearchAnswerGuardFailure(
            category.Value,
            reasonCode,
            detail
        );
    }

    private static SearchAnswerGuardFailure? TryParseLocalizedGuardFailure(string message)
    {
        if (!message.Contains("검색 실패", StringComparison.Ordinal))
        {
            return null;
        }

        var reasonMatch = GroundedFailureReasonPattern.Match(message);
        if (!reasonMatch.Success)
        {
            return null;
        }

        var reasonCode = NormalizeGuardFailureToken(reasonMatch.Groups["reason"].Value, "unknown");
        var category = ResolveGuardFailureCategory(reasonCode);
        var detailSegments = new List<string>(2);
        var terminationCode = string.Empty;

        var terminationMatch = GroundedFailureTerminationPattern.Match(message);
        if (terminationMatch.Success)
        {
            terminationCode = NormalizeGuardFailureToken(terminationMatch.Groups["termination"].Value, string.Empty);
            if (terminationCode.Length > 0)
            {
                detailSegments.Add($"termination={terminationCode}");
            }
        }

        var detailMatch = GroundedFailureDetailPattern.Match(message);
        if (detailMatch.Success)
        {
            var detail = (detailMatch.Groups["detail"].Value ?? string.Empty)
                .Replace('\r', ' ')
                .Replace('\n', ' ')
                .Trim();
            if (detail.Length > 0
                && (terminationCode.Length == 0
                    || !detail.Contains($"termination={terminationCode}", StringComparison.OrdinalIgnoreCase)))
            {
                detailSegments.Add(detail);
            }
        }

        var mergedDetail = detailSegments.Count == 0
            ? "-"
            : string.Join(", ", detailSegments);
        return new SearchAnswerGuardFailure(
            category,
            reasonCode,
            mergedDetail
        );
    }

    private static string NormalizeGuardFailureToken(string? value, string fallback)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static SearchAnswerGuardFailureCategory ResolveGuardFailureCategory(string reasonCode)
    {
        return reasonCode switch
        {
            "freshness_guard_failed" => SearchAnswerGuardFailureCategory.Freshness,
            "credibility_guard_failed" => SearchAnswerGuardFailureCategory.Credibility,
            _ => SearchAnswerGuardFailureCategory.Coverage
        };
    }

    private async Task SendGuardedErrorAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string message,
        CancellationToken cancellationToken,
        SearchAnswerGuardFailure? guardFailure = null
    )
    {
        var effectiveGuardFailure = guardFailure ?? TryParseGuardFailureFromMessage(message);
        var retryDirective = ResolveRetryDirective(effectiveGuardFailure);
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"error\","
            + $"\"message\":\"{EscapeJson(message)}\","
            + $"\"guardCategory\":\"{EscapeJson(NormalizeWebSearchGuardCategory(effectiveGuardFailure))}\","
            + $"\"guardReason\":\"{EscapeJson(NormalizeWebSearchGuardReason(effectiveGuardFailure))}\","
            + $"\"guardDetail\":\"{EscapeJson(NormalizeWebSearchGuardDetail(effectiveGuardFailure))}\","
            + $"\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")},"
            + $"\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\","
            + $"\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\","
            + $"\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\""
            + "}",
            cancellationToken
        );
    }

    private async Task SendWebFetchResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedUrl,
        string? requestedExtractMode,
        int? requestedMaxChars,
        WebFetchToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"web_fetch_result\",");
        builder.Append($"\"url\":\"{EscapeJson(result.Url)}\",");
        builder.Append($"\"requestedUrl\":\"{EscapeJson(requestedUrl)}\",");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        builder.Append($"\"extractMode\":\"{EscapeJson(result.ExtractMode)}\",");
        if (!string.IsNullOrWhiteSpace(requestedExtractMode))
        {
            builder.Append($"\"requestedExtractMode\":\"{EscapeJson(requestedExtractMode.Trim())}\",");
        }

        if (requestedMaxChars.HasValue)
        {
            builder.Append($"\"maxChars\":{requestedMaxChars.Value},");
        }

        if (!string.IsNullOrWhiteSpace(result.FinalUrl))
        {
            builder.Append($"\"finalUrl\":\"{EscapeJson(result.FinalUrl)}\",");
        }

        if (result.Status.HasValue)
        {
            builder.Append($"\"status\":{result.Status.Value},");
        }

        if (!string.IsNullOrWhiteSpace(result.ContentType))
        {
            builder.Append($"\"contentType\":\"{EscapeJson(result.ContentType)}\",");
        }

        builder.Append($"\"truncated\":{(result.Truncated ? "true" : "false")},");
        builder.Append($"\"length\":{result.Length},");
        builder.Append($"\"text\":\"{EscapeJson(result.Text)}\"");
        if (result.ExternalContent is not null)
        {
            builder.Append(",\"externalContent\":{");
            builder.Append($"\"untrusted\":{(result.ExternalContent.Untrusted ? "true" : "false")},");
            builder.Append($"\"source\":\"{EscapeJson(result.ExternalContent.Source)}\",");
            builder.Append($"\"provider\":\"{EscapeJson(result.ExternalContent.Provider)}\",");
            builder.Append($"\"wrapped\":{(result.ExternalContent.Wrapped ? "true" : "false")}");
            builder.Append("}");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendMemoryGetResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedPath,
        int? fromLine,
        int? lines,
        MemoryGetToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"memory_get_result\",");
        builder.Append($"\"path\":\"{EscapeJson(result.Path)}\",");
        builder.Append($"\"requestedPath\":\"{EscapeJson(requestedPath)}\",");
        builder.Append($"\"disabled\":{(result.Disabled ? "true" : "false")},");
        if (fromLine.HasValue)
        {
            builder.Append($"\"from\":{fromLine.Value},");
        }

        if (lines.HasValue)
        {
            builder.Append($"\"lines\":{lines.Value},");
        }

        builder.Append($"\"text\":\"{EscapeJson(result.Text)}\"");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendSessionsListResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        IReadOnlyList<string> kinds,
        int? limit,
        int? activeMinutes,
        int? messageLimit,
        string? search,
        string? scope,
        string? mode,
        SessionListToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"sessions_list_result\",");
        if (limit.HasValue)
        {
            builder.Append($"\"limit\":{limit.Value},");
        }

        if (activeMinutes.HasValue)
        {
            builder.Append($"\"activeMinutes\":{activeMinutes.Value},");
        }

        if (messageLimit.HasValue)
        {
            builder.Append($"\"messageLimit\":{messageLimit.Value},");
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            builder.Append($"\"search\":\"{EscapeJson(search.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(scope))
        {
            builder.Append($"\"scope\":\"{EscapeJson(scope.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(mode))
        {
            builder.Append($"\"mode\":\"{EscapeJson(mode.Trim())}\",");
        }

        builder.Append("\"kinds\":[");
        for (var i = 0; i < kinds.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append($"\"{EscapeJson(kinds[i])}\"");
        }

        builder.Append("],");
        builder.Append($"\"count\":{result.Count},");
        builder.Append("\"sessions\":[");
        for (var i = 0; i < result.Sessions.Count; i++)
        {
            var item = result.Sessions[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"key\":\"{EscapeJson(item.Key)}\",");
            builder.Append($"\"kind\":\"{EscapeJson(item.Kind)}\",");
            builder.Append($"\"scope\":\"{EscapeJson(item.Scope)}\",");
            builder.Append($"\"mode\":\"{EscapeJson(item.Mode)}\",");
            builder.Append($"\"label\":\"{EscapeJson(item.Label)}\",");
            builder.Append($"\"displayName\":\"{EscapeJson(item.DisplayName)}\",");
            builder.Append($"\"project\":\"{EscapeJson(item.Project)}\",");
            builder.Append($"\"category\":\"{EscapeJson(item.Category)}\",");
            builder.Append($"\"updatedAt\":{item.UpdatedAt},");
            builder.Append($"\"messageCount\":{item.MessageCount},");
            builder.Append($"\"preview\":\"{EscapeJson(item.Preview)}\",");
            builder.Append("\"tags\":[");
            for (var j = 0; j < item.Tags.Count; j++)
            {
                if (j > 0)
                {
                    builder.Append(",");
                }

                builder.Append($"\"{EscapeJson(item.Tags[j])}\"");
            }

            builder.Append("],");
            builder.Append("\"linkedMemoryNotes\":[");
            for (var j = 0; j < item.LinkedMemoryNotes.Count; j++)
            {
                if (j > 0)
                {
                    builder.Append(",");
                }

                builder.Append($"\"{EscapeJson(item.LinkedMemoryNotes[j])}\"");
            }

            builder.Append("],");
            builder.Append("\"messages\":[");
            for (var j = 0; j < item.Messages.Count; j++)
            {
                var message = item.Messages[j];
                if (j > 0)
                {
                    builder.Append(",");
                }

                builder.Append("{");
                builder.Append($"\"role\":\"{EscapeJson(message.Role)}\",");
                builder.Append($"\"text\":\"{EscapeJson(message.Text)}\",");
                builder.Append($"\"createdUtc\":\"{EscapeJson(message.CreatedUtc)}\"");
                builder.Append("}");
            }

            builder.Append("]");
            builder.Append("}");
        }

        builder.Append("]");
        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendSessionsHistoryResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string? requestedSessionKey,
        int? limit,
        bool? includeTools,
        SessionHistoryToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"sessions_history_result\",");
        builder.Append($"\"sessionKey\":\"{EscapeJson(result.SessionKey)}\",");
        builder.Append($"\"requestedSessionKey\":\"{EscapeJson((requestedSessionKey ?? string.Empty).Trim())}\",");
        if (limit.HasValue)
        {
            builder.Append($"\"limit\":{limit.Value},");
        }

        if (includeTools.HasValue)
        {
            builder.Append($"\"includeTools\":{(includeTools.Value ? "true" : "false")},");
        }

        builder.Append($"\"status\":\"{EscapeJson(result.Status)}\",");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($"\"error\":\"{EscapeJson(result.Error)}\",");
        }

        builder.Append($"\"count\":{result.Count},");
        builder.Append($"\"truncated\":{(result.Truncated ? "true" : "false")},");
        builder.Append($"\"droppedMessages\":{(result.DroppedMessages ? "true" : "false")},");
        builder.Append($"\"contentTruncated\":{(result.ContentTruncated ? "true" : "false")},");
        builder.Append($"\"contentRedacted\":{(result.ContentRedacted ? "true" : "false")},");
        builder.Append($"\"bytes\":{result.Bytes},");
        builder.Append("\"messages\":[");
        for (var i = 0; i < result.Messages.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var message = result.Messages[i];
            builder.Append("{");
            builder.Append($"\"role\":\"{EscapeJson(message.Role)}\",");
            builder.Append($"\"text\":\"{EscapeJson(message.Text)}\",");
            builder.Append($"\"createdUtc\":\"{EscapeJson(message.CreatedUtc)}\"");
            builder.Append("}");
        }

        builder.Append("]");
        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendSessionsSendResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string? requestedSessionKey,
        int? timeoutSeconds,
        SessionSendToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"sessions_send_result\",");
        builder.Append($"\"sessionKey\":\"{EscapeJson(result.SessionKey)}\",");
        builder.Append($"\"requestedSessionKey\":\"{EscapeJson((requestedSessionKey ?? string.Empty).Trim())}\",");
        builder.Append($"\"timeoutSeconds\":{result.TimeoutSeconds},");
        if (timeoutSeconds.HasValue)
        {
            builder.Append($"\"requestedTimeoutSeconds\":{timeoutSeconds.Value},");
        }

        builder.Append($"\"status\":\"{EscapeJson(result.Status)}\",");
        builder.Append($"\"runId\":\"{EscapeJson(result.RunId)}\",");
        builder.Append($"\"messageTruncated\":{(result.MessageTruncated ? "true" : "false")}");
        if (!string.IsNullOrWhiteSpace(result.Reply))
        {
            builder.Append($",\"reply\":\"{EscapeJson(result.Reply)}\"");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        if (string.Equals(result.Status, "ok", StringComparison.OrdinalIgnoreCase)
            || string.Equals(result.Status, "accepted", StringComparison.OrdinalIgnoreCase))
        {
            builder.Append(",\"delivery\":{\"status\":\"pending\",\"mode\":\"announce\"}");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendSessionsSpawnResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedTask,
        string? requestedLabel,
        string? requestedRuntime,
        int? requestedRunTimeoutSeconds,
        int? requestedTimeoutSeconds,
        bool? requestedThread,
        string? requestedMode,
        SessionSpawnToolResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"sessions_spawn_result\",");
        builder.Append($"\"task\":\"{EscapeJson(requestedTask)}\",");
        if (!string.IsNullOrWhiteSpace(requestedLabel))
        {
            builder.Append($"\"label\":\"{EscapeJson(requestedLabel.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedRuntime))
        {
            builder.Append($"\"requestedRuntime\":\"{EscapeJson(requestedRuntime.Trim())}\",");
        }

        if (!string.IsNullOrWhiteSpace(requestedMode))
        {
            builder.Append($"\"requestedMode\":\"{EscapeJson(requestedMode.Trim())}\",");
        }

        if (requestedRunTimeoutSeconds.HasValue)
        {
            builder.Append($"\"requestedRunTimeoutSeconds\":{requestedRunTimeoutSeconds.Value},");
        }

        if (requestedTimeoutSeconds.HasValue)
        {
            builder.Append($"\"requestedTimeoutSeconds\":{requestedTimeoutSeconds.Value},");
        }

        if (requestedThread.HasValue)
        {
            builder.Append($"\"requestedThread\":{(requestedThread.Value ? "true" : "false")},");
        }

        builder.Append($"\"status\":\"{EscapeJson(result.Status)}\",");
        builder.Append($"\"runId\":\"{EscapeJson(result.RunId)}\",");
        builder.Append($"\"childSessionKey\":\"{EscapeJson(result.ChildSessionKey)}\",");
        builder.Append($"\"mode\":\"{EscapeJson(result.Mode)}\",");
        builder.Append($"\"runtime\":\"{EscapeJson(result.Runtime)}\",");
        builder.Append($"\"runTimeoutSeconds\":{result.RunTimeoutSeconds},");
        builder.Append($"\"thread\":{(result.Thread ? "true" : "false")},");
        builder.Append($"\"taskTruncated\":{(result.TaskTruncated ? "true" : "false")},");
        builder.Append($"\"followUpStatus\":\"{EscapeJson(result.FollowUpStatus)}\",");
        builder.Append($"\"followUpAction\":\"{EscapeJson(result.FollowUpAction)}\"");
        if (!string.IsNullOrWhiteSpace(result.BackendSessionId))
        {
            builder.Append($",\"backendSessionId\":\"{EscapeJson(result.BackendSessionId)}\"");
        }

        if (!string.IsNullOrWhiteSpace(result.ThreadBindingKey))
        {
            builder.Append($",\"threadBindingKey\":\"{EscapeJson(result.ThreadBindingKey)}\"");
        }

        if (!string.IsNullOrWhiteSpace(result.Note))
        {
            builder.Append($",\"note\":\"{EscapeJson(result.Note)}\"");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronStatusResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CronToolStatusResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"status\",");
        builder.Append($"\"enabled\":{(result.Enabled ? "true" : "false")},");
        builder.Append($"\"storePath\":\"{EscapeJson(result.StorePath)}\",");
        builder.Append($"\"jobs\":{result.Jobs},");
        builder.Append($"\"nextWakeAtMs\":{(result.NextWakeAtMs.HasValue ? result.NextWakeAtMs.Value.ToString(CultureInfo.InvariantCulture) : "null")}");
        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronListResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        bool includeDisabled,
        int? requestedLimit,
        int? requestedOffset,
        CronToolListResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"list\",");
        builder.Append($"\"includeDisabled\":{(includeDisabled ? "true" : "false")},");
        if (requestedLimit.HasValue)
        {
            builder.Append($"\"requestedLimit\":{requestedLimit.Value},");
        }

        if (requestedOffset.HasValue)
        {
            builder.Append($"\"requestedOffset\":{requestedOffset.Value},");
        }

        builder.Append($"\"total\":{result.Total},");
        builder.Append($"\"offset\":{result.Offset},");
        builder.Append($"\"limit\":{result.Limit},");
        builder.Append($"\"hasMore\":{(result.HasMore ? "true" : "false")},");
        builder.Append($"\"nextOffset\":{(result.NextOffset.HasValue ? result.NextOffset.Value.ToString(CultureInfo.InvariantCulture) : "null")},");
        builder.Append("\"jobs\":[");
        for (var i = 0; i < result.Jobs.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            AppendCronJobJson(builder, result.Jobs[i]);
        }

        builder.Append("]");
        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronRunResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedJobId,
        string? requestedRunMode,
        CronToolRunResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"run\",");
        builder.Append($"\"jobId\":\"{EscapeJson(requestedJobId)}\",");
        if (!string.IsNullOrWhiteSpace(requestedRunMode))
        {
            builder.Append($"\"runMode\":\"{EscapeJson(requestedRunMode.Trim())}\",");
        }

        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"ran\":{(result.Ran ? "true" : "false")}");
        if (!string.IsNullOrWhiteSpace(result.Reason))
        {
            builder.Append($",\"reason\":\"{EscapeJson(result.Reason)}\"");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronWakeResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string? requestedMode,
        int requestedTextLength,
        CronToolWakeResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"wake\",");
        if (!string.IsNullOrWhiteSpace(requestedMode))
        {
            builder.Append($"\"requestedMode\":\"{EscapeJson(requestedMode.Trim())}\",");
        }

        builder.Append($"\"textLength\":{requestedTextLength},");
        builder.Append($"\"mode\":\"{EscapeJson(result.Mode)}\",");
        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")}");
        if (result.Ok)
        {
            builder.Append($",\"triggeredRuns\":{result.TriggeredRuns}");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronRunsResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedJobId,
        int? requestedLimit,
        int? requestedOffset,
        CronToolRunsResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"runs\",");
        builder.Append($"\"jobId\":\"{EscapeJson(requestedJobId)}\",");
        if (requestedLimit.HasValue)
        {
            builder.Append($"\"requestedLimit\":{requestedLimit.Value},");
        }

        if (requestedOffset.HasValue)
        {
            builder.Append($"\"requestedOffset\":{requestedOffset.Value},");
        }

        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")}");
        if (result.Ok)
        {
            builder.Append($",\"total\":{result.Total}");
            builder.Append($",\"offset\":{result.Offset}");
            builder.Append($",\"limit\":{result.Limit}");
            builder.Append($",\"hasMore\":{(result.HasMore ? "true" : "false")}");
            builder.Append($",\"nextOffset\":{(result.NextOffset.HasValue ? result.NextOffset.Value.ToString(CultureInfo.InvariantCulture) : "null")}");
            builder.Append(",\"entries\":[");
            for (var i = 0; i < result.Entries.Count; i++)
            {
                if (i > 0)
                {
                    builder.Append(",");
                }

                AppendCronRunLogEntryJson(builder, result.Entries[i]);
            }

            builder.Append("]");
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronAddResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CronToolAddResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"add\",");
        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")}");
        if (result.Job != null)
        {
            builder.Append(",\"job\":");
            AppendCronJobJson(builder, result.Job);
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronUpdateResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedJobId,
        CronToolUpdateResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"update\",");
        builder.Append($"\"jobId\":\"{EscapeJson(requestedJobId)}\",");
        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")}");
        if (result.Job != null)
        {
            builder.Append(",\"job\":");
            AppendCronJobJson(builder, result.Job);
        }

        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendCronRemoveResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string requestedJobId,
        CronToolRemoveResult result,
        CancellationToken cancellationToken
    )
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append("\"type\":\"cron_result\",");
        builder.Append("\"action\":\"remove\",");
        builder.Append($"\"jobId\":\"{EscapeJson(requestedJobId)}\",");
        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"removed\":{(result.Removed ? "true" : "false")}");
        if (!string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(result.Error)}\"");
        }

        builder.Append("}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private static void AppendCronJobJson(StringBuilder builder, CronToolJob job)
    {
        builder.Append("{");
        builder.Append($"\"id\":\"{EscapeJson(job.Id)}\",");
        builder.Append($"\"name\":\"{EscapeJson(job.Name)}\",");
        builder.Append($"\"enabled\":{(job.Enabled ? "true" : "false")},");
        builder.Append($"\"createdAtMs\":{job.CreatedAtMs},");
        builder.Append($"\"updatedAtMs\":{job.UpdatedAtMs},");
        builder.Append($"\"sessionTarget\":\"{EscapeJson(job.SessionTarget)}\",");
        builder.Append($"\"wakeMode\":\"{EscapeJson(job.WakeMode)}\",");
        if (!string.IsNullOrWhiteSpace(job.Description))
        {
            builder.Append($"\"description\":\"{EscapeJson(job.Description)}\",");
        }

        builder.Append("\"schedule\":{");
        builder.Append($"\"kind\":\"{EscapeJson(job.Schedule.Kind)}\"");
        if (!string.IsNullOrWhiteSpace(job.Schedule.Expr))
        {
            builder.Append($",\"expr\":\"{EscapeJson(job.Schedule.Expr)}\"");
        }

        if (!string.IsNullOrWhiteSpace(job.Schedule.Tz))
        {
            builder.Append($",\"tz\":\"{EscapeJson(job.Schedule.Tz)}\"");
        }

        if (!string.IsNullOrWhiteSpace(job.Schedule.At))
        {
            builder.Append($",\"at\":\"{EscapeJson(job.Schedule.At)}\"");
        }

        if (job.Schedule.EveryMs.HasValue)
        {
            builder.Append($",\"everyMs\":{job.Schedule.EveryMs.Value}");
        }

        if (job.Schedule.AnchorMs.HasValue)
        {
            builder.Append($",\"anchorMs\":{job.Schedule.AnchorMs.Value}");
        }

        builder.Append("},");
        builder.Append("\"payload\":{");
        builder.Append($"\"kind\":\"{EscapeJson(job.Payload.Kind)}\"");
        if (string.Equals(job.Payload.Kind, "agentTurn", StringComparison.Ordinal))
        {
            var message = string.IsNullOrWhiteSpace(job.Payload.Message)
                ? (job.Payload.Text ?? string.Empty)
                : job.Payload.Message!;
            builder.Append($",\"message\":\"{EscapeJson(message)}\"");
            if (!string.IsNullOrWhiteSpace(job.Payload.Model))
            {
                builder.Append($",\"model\":\"{EscapeJson(job.Payload.Model)}\"");
            }

            if (!string.IsNullOrWhiteSpace(job.Payload.Thinking))
            {
                builder.Append($",\"thinking\":\"{EscapeJson(job.Payload.Thinking)}\"");
            }

            if (job.Payload.TimeoutSeconds.HasValue)
            {
                builder.Append($",\"timeoutSeconds\":{job.Payload.TimeoutSeconds.Value.ToString(CultureInfo.InvariantCulture)}");
            }

            if (job.Payload.LightContext.HasValue)
            {
                builder.Append($",\"lightContext\":{(job.Payload.LightContext.Value ? "true" : "false")}");
            }
        }
        else
        {
            var text = string.IsNullOrWhiteSpace(job.Payload.Text)
                ? (job.Payload.Message ?? string.Empty)
                : job.Payload.Text!;
            builder.Append($",\"text\":\"{EscapeJson(text)}\"");
        }
        builder.Append("},");
        builder.Append("\"state\":{");
        builder.Append($"\"nextRunAtMs\":{ToJsonLongOrNull(job.State.NextRunAtMs)},");
        builder.Append($"\"runningAtMs\":{ToJsonLongOrNull(job.State.RunningAtMs)},");
        builder.Append($"\"lastRunAtMs\":{ToJsonLongOrNull(job.State.LastRunAtMs)},");
        builder.Append($"\"lastRunStatus\":{ToJsonStringOrNull(job.State.LastRunStatus)},");
        builder.Append($"\"lastError\":{ToJsonStringOrNull(job.State.LastError)},");
        builder.Append($"\"lastDurationMs\":{ToJsonLongOrNull(job.State.LastDurationMs)}");
        builder.Append("}");
        builder.Append("}");
    }

    private static void AppendCronRunLogEntryJson(StringBuilder builder, CronToolRunLogEntry entry)
    {
        builder.Append("{");
        builder.Append($"\"ts\":{entry.Ts.ToString(CultureInfo.InvariantCulture)},");
        builder.Append($"\"jobId\":\"{EscapeJson(entry.JobId)}\",");
        builder.Append($"\"action\":\"{EscapeJson(entry.Action)}\"");
        if (!string.IsNullOrWhiteSpace(entry.Status))
        {
            builder.Append($",\"status\":\"{EscapeJson(entry.Status)}\"");
        }

        if (!string.IsNullOrWhiteSpace(entry.Error))
        {
            builder.Append($",\"error\":\"{EscapeJson(entry.Error)}\"");
        }

        if (!string.IsNullOrWhiteSpace(entry.Summary))
        {
            builder.Append($",\"summary\":\"{EscapeJson(entry.Summary)}\"");
        }

        if (entry.RunAtMs.HasValue)
        {
            builder.Append($",\"runAtMs\":{entry.RunAtMs.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (entry.DurationMs.HasValue)
        {
            builder.Append($",\"durationMs\":{entry.DurationMs.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (entry.NextRunAtMs.HasValue)
        {
            builder.Append($",\"nextRunAtMs\":{entry.NextRunAtMs.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (!string.IsNullOrWhiteSpace(entry.JobName))
        {
            builder.Append($",\"jobName\":\"{EscapeJson(entry.JobName)}\"");
        }

        builder.Append("}");
    }

    private static string ToJsonLongOrNull(long? value)
    {
        return value.HasValue
            ? value.Value.ToString(CultureInfo.InvariantCulture)
            : "null";
    }

    private static string ToJsonStringOrNull(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? "null"
            : $"\"{EscapeJson(value)}\"";
    }

    private async Task SendRoutinesAsync(WebSocket socket, SemaphoreSlim sendLock, CancellationToken cancellationToken)
    {
        var items = _commandService.ListRoutines();
        var builder = new StringBuilder();
        builder.Append("{\"type\":\"routines_state\",\"items\":[");
        for (var i = 0; i < items.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append(BuildRoutineJson(items[i]));
        }

        builder.Append("]}");
        await SendTextAsync(socket, sendLock, builder.ToString(), cancellationToken);
    }

    private async Task SendRoutineActionResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        RoutineActionResult result,
        CancellationToken cancellationToken
    )
    {
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"routine_result\","
            + $"\"ok\":{(result.Ok ? "true" : "false")},"
            + $"\"message\":\"{EscapeJson(result.Message)}\","
            + $"\"routine\":{(result.Routine == null ? "null" : BuildRoutineJson(result.Routine))}"
            + "}",
            cancellationToken
        );
    }

    private async Task SendChatResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        ConversationChatResult result,
        CancellationToken cancellationToken
    )
    {
        var retryDirective = ResolveRetryDirective(result.GuardFailure);
        var normalizedRetryStopReason = NormalizeWebSearchRetryStopReason(result.RetryStopReason);
        TrackGuardRetryTimelineEntry(
            channel: "chat",
            retryRequired: retryDirective.RetryRequired,
            retryAttempt: result.RetryAttempt,
            retryMaxAttempts: result.RetryMaxAttempts,
            retryStopReason: normalizedRetryStopReason
        );
        var finalizeStopwatch = Stopwatch.StartNew();
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"llm_chat_result\","
            + $"\"mode\":\"{EscapeJson(result.Mode)}\","
            + $"\"conversationId\":\"{EscapeJson(result.ConversationId)}\","
            + $"\"provider\":\"{EscapeJson(result.Provider)}\","
            + $"\"model\":\"{EscapeJson(result.Model)}\","
            + $"\"route\":\"{EscapeJson(result.Route)}\","
            + $"\"text\":\"{EscapeJson(result.Text)}\","
            + $"\"conversation\":{BuildConversationJson(result.Conversation)},"
            + $"\"autoMemoryNote\":{BuildMemoryNoteJson(result.AutoMemoryNote)},"
            + $"\"citations\":{BuildSearchCitationArrayJson(result.Citations)},"
            + $"\"citationMappings\":{BuildSearchCitationMappingArrayJson(result.CitationMappings)},"
            + $"\"citationValidation\":{BuildSearchCitationValidationJson(result.CitationValidation)},"
            + $"\"guardCategory\":\"{EscapeJson(NormalizeWebSearchGuardCategory(result.GuardFailure))}\","
            + $"\"guardReason\":\"{EscapeJson(NormalizeWebSearchGuardReason(result.GuardFailure))}\","
            + $"\"guardDetail\":\"{EscapeJson(NormalizeWebSearchGuardDetail(result.GuardFailure))}\","
            + $"\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")},"
            + $"\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\","
            + $"\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\","
            + $"\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\","
            + $"\"retryAttempt\":{Math.Max(0, result.RetryAttempt)},"
            + $"\"retryMaxAttempts\":{Math.Max(0, result.RetryMaxAttempts)},"
            + $"\"retryStopReason\":\"{EscapeJson(normalizedRetryStopReason)}\""
            + "}",
            cancellationToken
        );
        if (result.Latency != null && result.Route.Equals("gemini-web-single", StringComparison.OrdinalIgnoreCase))
        {
            _auditLogger.Log(
                "web",
                "chat_single:web",
                "ok",
                $"decision_ms={result.Latency.DecisionMs.ToString(CultureInfo.InvariantCulture)} "
                + $"prompt_build_ms={result.Latency.PromptBuildMs.ToString(CultureInfo.InvariantCulture)} "
                + $"first_chunk_ms={result.Latency.FirstChunkMs.ToString(CultureInfo.InvariantCulture)} "
                + $"full_response_ms={result.Latency.FullResponseMs.ToString(CultureInfo.InvariantCulture)} "
                + $"sanitize_ms={result.Latency.SanitizeMs.ToString(CultureInfo.InvariantCulture)} "
                + $"ws_finalize_ms={Math.Max(0L, finalizeStopwatch.ElapsedMilliseconds).ToString(CultureInfo.InvariantCulture)} "
                + $"model={NormalizeAuditToken(result.Model, "-")} "
                + $"route={NormalizeAuditToken(result.Route, "-")} "
                + $"decision_path={NormalizeAuditToken(result.Latency.DecisionPath, "-")}"
            );
        }
    }

    private async Task SendChatStreamChunkAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        ChatStreamUpdate update,
        CancellationToken cancellationToken
    )
    {
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"llm_chat_stream_chunk\","
            + $"\"scope\":\"{EscapeJson(update.Scope)}\","
            + $"\"mode\":\"{EscapeJson(update.Mode)}\","
            + $"\"provider\":\"{EscapeJson(update.Provider)}\","
            + $"\"model\":\"{EscapeJson(update.Model)}\","
            + $"\"route\":\"{EscapeJson(update.Route)}\","
            + $"\"delta\":\"{EscapeJson(update.Delta)}\","
            + $"\"conversationId\":\"{EscapeJson(update.ConversationId)}\","
            + $"\"chunkIndex\":{Math.Max(0, update.ChunkIndex)}"
            + "}",
            cancellationToken
        );
    }

    private static string NormalizeAuditToken(string? token, string fallback)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return fallback;
        }

        var normalized = token.Trim();
        return normalized.Length == 0 ? fallback : normalized.Replace(' ', '_');
    }

    private async Task SendCodingResultAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CodingRunResult result,
        CancellationToken cancellationToken
    )
    {
        var retryDirective = ResolveRetryDirective(result.GuardFailure);
        var normalizedRetryStopReason = NormalizeWebSearchRetryStopReason(result.RetryStopReason);
        TrackGuardRetryTimelineEntry(
            channel: "coding",
            retryRequired: retryDirective.RetryRequired,
            retryAttempt: result.RetryAttempt,
            retryMaxAttempts: result.RetryMaxAttempts,
            retryStopReason: normalizedRetryStopReason
        );
        await SendTextAsync(
            socket,
            sendLock,
            "{"
            + "\"type\":\"coding_result\","
            + $"\"mode\":\"{EscapeJson(result.Mode)}\","
            + $"\"conversationId\":\"{EscapeJson(result.ConversationId)}\","
            + $"\"provider\":\"{EscapeJson(result.Provider)}\","
            + $"\"model\":\"{EscapeJson(result.Model)}\","
            + $"\"language\":\"{EscapeJson(result.Language)}\","
            + "\"code\":\"\","
            + $"\"summary\":\"{EscapeJson(result.Summary)}\","
            + $"\"execution\":{BuildExecutionJson(result.Execution)},"
            + $"\"workers\":{BuildCodingWorkersJson(result.Workers)},"
            + $"\"changedFiles\":{BuildStringArrayJson(result.ChangedFiles)},"
            + $"\"conversation\":{BuildConversationJson(result.Conversation)},"
            + $"\"autoMemoryNote\":{BuildMemoryNoteJson(result.AutoMemoryNote)},"
            + $"\"citations\":{BuildSearchCitationArrayJson(result.Citations)},"
            + $"\"citationMappings\":{BuildSearchCitationMappingArrayJson(result.CitationMappings)},"
            + $"\"citationValidation\":{BuildSearchCitationValidationJson(result.CitationValidation)},"
            + $"\"guardCategory\":\"{EscapeJson(NormalizeWebSearchGuardCategory(result.GuardFailure))}\","
            + $"\"guardReason\":\"{EscapeJson(NormalizeWebSearchGuardReason(result.GuardFailure))}\","
            + $"\"guardDetail\":\"{EscapeJson(NormalizeWebSearchGuardDetail(result.GuardFailure))}\","
            + $"\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")},"
            + $"\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\","
            + $"\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\","
            + $"\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\","
            + $"\"retryAttempt\":{Math.Max(0, result.RetryAttempt)},"
            + $"\"retryMaxAttempts\":{Math.Max(0, result.RetryMaxAttempts)},"
            + $"\"retryStopReason\":\"{EscapeJson(normalizedRetryStopReason)}\""
            + "}",
            cancellationToken
        );
    }

    private async Task SendCodingProgressAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string scope,
        string mode,
        CodingProgressUpdate update,
        CancellationToken cancellationToken
    )
    {
        try
        {
            await SendTextAsync(
                socket,
                sendLock,
                "{"
                + "\"type\":\"coding_progress\","
                + $"\"scope\":\"{EscapeJson(scope)}\","
                + $"\"mode\":\"{EscapeJson(mode)}\","
                + $"\"provider\":\"{EscapeJson(update.Provider)}\","
                + $"\"model\":\"{EscapeJson(update.Model)}\","
                + $"\"phase\":\"{EscapeJson(update.Phase)}\","
                + $"\"message\":\"{EscapeJson(update.Message)}\","
                + $"\"iteration\":{update.Iteration},"
                + $"\"maxIterations\":{update.MaxIterations},"
                + $"\"percent\":{update.Percent},"
                + $"\"done\":{(update.Done ? "true" : "false")}"
                + "}",
                cancellationToken
            );
        }
        catch
        {
        }
    }

    private static string BuildMultiChatResultJson(ConversationMultiResult result)
    {
        var retryDirective = ResolveRetryDirective(result.GuardFailure);
        return "{"
               + "\"type\":\"llm_chat_multi_result\","
               + $"\"conversationId\":\"{EscapeJson(result.ConversationId)}\","
               + $"\"groq\":\"{EscapeJson(result.GroqText)}\","
               + $"\"gemini\":\"{EscapeJson(result.GeminiText)}\","
               + $"\"cerebras\":\"{EscapeJson(result.CerebrasText)}\","
               + $"\"copilot\":\"{EscapeJson(result.CopilotText)}\","
               + $"\"summary\":\"{EscapeJson(result.Summary)}\","
               + $"\"groqModel\":\"{EscapeJson(result.GroqModel)}\","
               + $"\"geminiModel\":\"{EscapeJson(result.GeminiModel)}\","
               + $"\"cerebrasModel\":\"{EscapeJson(result.CerebrasModel)}\","
               + $"\"copilotModel\":\"{EscapeJson(result.CopilotModel)}\","
               + $"\"requestedSummaryProvider\":\"{EscapeJson(result.RequestedSummaryProvider)}\","
               + $"\"resolvedSummaryProvider\":\"{EscapeJson(result.ResolvedSummaryProvider)}\","
               + $"\"conversation\":{BuildConversationJson(result.Conversation)},"
               + $"\"autoMemoryNote\":{BuildMemoryNoteJson(result.AutoMemoryNote)},"
               + $"\"citations\":{BuildSearchCitationArrayJson(result.Citations)},"
               + $"\"citationMappings\":{BuildSearchCitationMappingArrayJson(result.CitationMappings)},"
               + $"\"citationValidation\":{BuildSearchCitationValidationJson(result.CitationValidation)},"
               + $"\"guardCategory\":\"{EscapeJson(NormalizeWebSearchGuardCategory(result.GuardFailure))}\","
               + $"\"guardReason\":\"{EscapeJson(NormalizeWebSearchGuardReason(result.GuardFailure))}\","
               + $"\"guardDetail\":\"{EscapeJson(NormalizeWebSearchGuardDetail(result.GuardFailure))}\","
               + $"\"retryRequired\":{(retryDirective.RetryRequired ? "true" : "false")},"
               + $"\"retryAction\":\"{EscapeJson(retryDirective.RetryAction)}\","
               + $"\"retryScope\":\"{EscapeJson(retryDirective.RetryScope)}\","
               + $"\"retryReason\":\"{EscapeJson(retryDirective.RetryReason)}\""
               + "}";
    }

    private static string BuildConversationJson(ConversationThreadView conversation)
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append($"\"id\":\"{EscapeJson(conversation.Id)}\",");
        builder.Append($"\"scope\":\"{EscapeJson(conversation.Scope)}\",");
        builder.Append($"\"mode\":\"{EscapeJson(conversation.Mode)}\",");
        builder.Append($"\"title\":\"{EscapeJson(conversation.Title)}\",");
        builder.Append($"\"project\":\"{EscapeJson(conversation.Project)}\",");
        builder.Append($"\"category\":\"{EscapeJson(conversation.Category)}\",");
        builder.Append($"\"createdUtc\":\"{EscapeJson(conversation.CreatedUtc.ToString("O"))}\",");
        builder.Append($"\"updatedUtc\":\"{EscapeJson(conversation.UpdatedUtc.ToString("O"))}\",");
        builder.Append("\"tags\":[");
        for (var i = 0; i < conversation.Tags.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append($"\"{EscapeJson(conversation.Tags[i])}\"");
        }

        builder.Append("],");
        builder.Append("\"linkedMemoryNotes\":[");
        for (var i = 0; i < conversation.LinkedMemoryNotes.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append($"\"{EscapeJson(conversation.LinkedMemoryNotes[i])}\"");
        }

        builder.Append("],");
        builder.Append("\"messages\":[");
        for (var i = 0; i < conversation.Messages.Count; i++)
        {
            var message = conversation.Messages[i];
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append("{");
            builder.Append($"\"role\":\"{EscapeJson(message.Role)}\",");
            builder.Append($"\"text\":\"{EscapeJson(message.Text)}\",");
            builder.Append($"\"meta\":\"{EscapeJson(message.Meta)}\",");
            builder.Append($"\"createdUtc\":\"{EscapeJson(message.CreatedUtc.ToString("O"))}\"");
            builder.Append("}");
        }

        builder.Append("]}");
        return builder.ToString();
    }

    private static string BuildMemoryNoteJson(MemoryNoteSaveResult? note)
    {
        if (note == null)
        {
            return "null";
        }

        return "{"
               + $"\"name\":\"{EscapeJson(note.Name)}\","
               + $"\"fullPath\":\"{EscapeJson(note.FullPath)}\","
               + $"\"excerpt\":\"{EscapeJson(note.Excerpt)}\""
               + "}";
    }

    private static string BuildRoutineJson(RoutineSummary routine)
    {
        return "{"
               + $"\"id\":\"{EscapeJson(routine.Id)}\","
               + $"\"title\":\"{EscapeJson(routine.Title)}\","
               + $"\"request\":\"{EscapeJson(routine.Request)}\","
               + $"\"scheduleText\":\"{EscapeJson(routine.ScheduleText)}\","
               + $"\"enabled\":{(routine.Enabled ? "true" : "false")},"
               + $"\"nextRunLocal\":\"{EscapeJson(routine.NextRunLocal)}\","
               + $"\"lastRunLocal\":\"{EscapeJson(routine.LastRunLocal)}\","
               + $"\"lastStatus\":\"{EscapeJson(routine.LastStatus)}\","
               + $"\"lastOutput\":\"{EscapeJson(TrimTo(routine.LastOutput, 1200))}\","
               + $"\"scriptPath\":\"{EscapeJson(routine.ScriptPath)}\","
               + $"\"language\":\"{EscapeJson(routine.Language)}\","
               + $"\"coderModel\":\"{EscapeJson(routine.CoderModel)}\""
               + "}";
    }

    private static string TrimTo(string value, int maxChars)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        if (value.Length <= maxChars)
        {
            return value;
        }

        return value[..maxChars] + "...";
    }

    private static string BuildExecutionJson(CodeExecutionResult result)
    {
        return "{"
               + $"\"language\":\"{EscapeJson(result.Language)}\","
               + $"\"runDirectory\":\"{EscapeJson(result.RunDirectory)}\","
               + $"\"entryFile\":\"{EscapeJson(result.EntryFile)}\","
               + $"\"command\":\"{EscapeJson(result.Command)}\","
               + $"\"exitCode\":{result.ExitCode},"
               + $"\"stdout\":\"{EscapeJson(result.StdOut)}\","
               + $"\"stderr\":\"{EscapeJson(result.StdErr)}\","
               + $"\"status\":\"{EscapeJson(result.Status)}\""
               + "}";
    }

    private static string BuildCodingWorkersJson(IReadOnlyList<CodingWorkerResult> workers)
    {
        var builder = new StringBuilder();
        builder.Append("[");
        for (var i = 0; i < workers.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var worker = workers[i];
            builder.Append("{");
            builder.Append($"\"provider\":\"{EscapeJson(worker.Provider)}\",");
            builder.Append($"\"model\":\"{EscapeJson(worker.Model)}\",");
            builder.Append($"\"language\":\"{EscapeJson(worker.Language)}\",");
            builder.Append("\"code\":\"\",");
            builder.Append("\"rawResponse\":\"\",");
            builder.Append($"\"execution\":{BuildExecutionJson(worker.Execution)},");
            builder.Append($"\"changedFiles\":{BuildStringArrayJson(worker.ChangedFiles)}");
            builder.Append("}");
        }

        builder.Append("]");
        return builder.ToString();
    }

    private static string BuildStringArrayJson(IReadOnlyList<string> values)
    {
        var builder = new StringBuilder();
        builder.Append("[");
        for (var i = 0; i < values.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            builder.Append($"\"{EscapeJson(values[i])}\"");
        }

        builder.Append("]");
        return builder.ToString();
    }

    private static string BuildSearchCitationArrayJson(IReadOnlyList<SearchCitationReference>? citations)
    {
        if (citations == null || citations.Count == 0)
        {
            return "[]";
        }

        var builder = new StringBuilder();
        builder.Append("[");
        for (var i = 0; i < citations.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var citation = citations[i];
            builder.Append("{");
            builder.Append($"\"citationId\":\"{EscapeJson(citation.CitationId)}\",");
            builder.Append($"\"title\":\"{EscapeJson(citation.Title)}\",");
            builder.Append($"\"url\":\"{EscapeJson(citation.Url)}\",");
            builder.Append($"\"published\":\"{EscapeJson(citation.Published)}\",");
            builder.Append($"\"snippet\":\"{EscapeJson(citation.Snippet)}\",");
            builder.Append($"\"sourceType\":\"{EscapeJson(citation.SourceType)}\"");
            builder.Append("}");
        }

        builder.Append("]");
        return builder.ToString();
    }

    private static string BuildSearchCitationMappingArrayJson(IReadOnlyList<SearchCitationSentenceMapping>? mappings)
    {
        if (mappings == null || mappings.Count == 0)
        {
            return "[]";
        }

        var builder = new StringBuilder();
        builder.Append("[");
        for (var i = 0; i < mappings.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var mapping = mappings[i];
            builder.Append("{");
            builder.Append($"\"segment\":\"{EscapeJson(mapping.Segment)}\",");
            builder.Append($"\"sentenceIndex\":{mapping.SentenceIndex},");
            builder.Append($"\"sentence\":\"{EscapeJson(mapping.Sentence)}\",");
            builder.Append($"\"citationIds\":{BuildStringArrayJson(mapping.CitationIds)},");
            builder.Append($"\"unknownCitationIds\":{BuildStringArrayJson(mapping.UnknownCitationIds)},");
            builder.Append($"\"missingCitation\":{(mapping.MissingCitation ? "true" : "false")}");
            builder.Append("}");
        }

        builder.Append("]");
        return builder.ToString();
    }

    private static string BuildSearchCitationValidationJson(SearchCitationValidationSummary? validation)
    {
        if (validation == null)
        {
            return "{\"totalSentences\":0,\"taggedSentences\":0,\"missingSentences\":0,\"unknownCitationSentences\":0,\"passed\":true}";
        }

        return "{"
               + $"\"totalSentences\":{validation.TotalSentences},"
               + $"\"taggedSentences\":{validation.TaggedSentences},"
               + $"\"missingSentences\":{validation.MissingSentences},"
               + $"\"unknownCitationSentences\":{validation.UnknownCitationSentences},"
               + $"\"passed\":{(validation.Passed ? "true" : "false")}"
               + "}";
    }

    private async Task SendMetricsAsync(WebSocket socket, SemaphoreSlim sendLock, string type, string metricsRaw, CancellationToken cancellationToken)
    {
        if (LooksLikeJson(metricsRaw))
        {
            await SendTextAsync(socket, sendLock, $"{{\"type\":\"{type}\",\"payload\":{metricsRaw}}}", cancellationToken);
            return;
        }

        await SendTextAsync(
            socket,
            sendLock,
            $"{{\"type\":\"{type}\",\"payload\":\"{EscapeJson(metricsRaw)}\"}}",
            cancellationToken
        );
    }

    private bool AllowCommand(string sessionId)
    {
        var now = DateTimeOffset.UtcNow;
        lock (_rateLock)
        {
            if (!_sessionRateMap.TryGetValue(sessionId, out var window))
            {
                _sessionRateMap[sessionId] = new RateWindow(now, 1);
                return true;
            }

            if (now - window.WindowStart >= TimeSpan.FromMinutes(1))
            {
                _sessionRateMap[sessionId] = new RateWindow(now, 1);
                return true;
            }

            if (window.Count >= _config.WebSocketCommandsPerMinute)
            {
                return false;
            }

            _sessionRateMap[sessionId] = window with { Count = window.Count + 1 };
            return true;
        }
    }

    private void ClearRateWindow(string sessionId)
    {
        lock (_rateLock)
        {
            _sessionRateMap.Remove(sessionId);
        }
    }

    private async Task<GuardAlertDispatchResult> DispatchGuardAlertEventAsync(
        string guardAlertEventJson,
        CancellationToken cancellationToken
    )
    {
        var attemptedAtUtc = DateTimeOffset.UtcNow.ToString("O");
        var schemaVersion = GuardAlertSchemaVersion;
        var eventType = GuardAlertEventType;

        try
        {
            using var eventDoc = JsonDocument.Parse(guardAlertEventJson);
            if (eventDoc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return new GuardAlertDispatchResult(
                    Ok: false,
                    Status: "invalid_payload",
                    Message: "guardAlertEvent must be an object",
                    SchemaVersion: schemaVersion,
                    EventType: eventType,
                    AttemptedAtUtc: attemptedAtUtc,
                    Targets: Array.Empty<GuardAlertDispatchTargetResult>()
                );
            }

            if (eventDoc.RootElement.TryGetProperty("schemaVersion", out var schemaVersionElement)
                && schemaVersionElement.ValueKind == JsonValueKind.String)
            {
                schemaVersion = schemaVersionElement.GetString()?.Trim() ?? schemaVersion;
            }

            if (eventDoc.RootElement.TryGetProperty("eventType", out var eventTypeElement)
                && eventTypeElement.ValueKind == JsonValueKind.String)
            {
                eventType = eventTypeElement.GetString()?.Trim() ?? eventType;
            }
        }
        catch (JsonException ex)
        {
            return new GuardAlertDispatchResult(
                Ok: false,
                Status: "invalid_json",
                Message: $"guardAlertEvent parse failed: {TrimTo(ex.Message, 120)}",
                SchemaVersion: schemaVersion,
                EventType: eventType,
                AttemptedAtUtc: attemptedAtUtc,
                Targets: Array.Empty<GuardAlertDispatchTargetResult>()
            );
        }

        if (!string.Equals(schemaVersion, GuardAlertSchemaVersion, StringComparison.Ordinal))
        {
            return new GuardAlertDispatchResult(
                Ok: false,
                Status: "invalid_schema_version",
                Message: $"schemaVersion must be {GuardAlertSchemaVersion}",
                SchemaVersion: schemaVersion,
                EventType: eventType,
                AttemptedAtUtc: attemptedAtUtc,
                Targets: Array.Empty<GuardAlertDispatchTargetResult>()
            );
        }

        if (!string.Equals(eventType, GuardAlertEventType, StringComparison.Ordinal))
        {
            return new GuardAlertDispatchResult(
                Ok: false,
                Status: "invalid_event_type",
                Message: $"eventType must be {GuardAlertEventType}",
                SchemaVersion: schemaVersion,
                EventType: eventType,
                AttemptedAtUtc: attemptedAtUtc,
                Targets: Array.Empty<GuardAlertDispatchTargetResult>()
            );
        }

        var targetConfigs = new (string Name, string Url)[]
        {
            ("webhook", _config.GuardAlertWebhookUrl),
            ("log_collector", _config.GuardAlertLogCollectorUrl)
        };
        var targetResults = new List<GuardAlertDispatchTargetResult>(targetConfigs.Length);

        foreach (var target in targetConfigs)
        {
            if (string.IsNullOrWhiteSpace(target.Url))
            {
                targetResults.Add(
                    new GuardAlertDispatchTargetResult(
                        Name: target.Name,
                        Status: "skipped",
                        Attempts: 0,
                        StatusCode: null,
                        Error: "target_not_configured",
                        Endpoint: "-"
                    )
                );
                continue;
            }

            if (!TryResolveGuardAlertEndpoint(target.Url, out var endpointUri, out var endpointDisplay, out var endpointError))
            {
                targetResults.Add(
                    new GuardAlertDispatchTargetResult(
                        Name: target.Name,
                        Status: "failed",
                        Attempts: 0,
                        StatusCode: null,
                        Error: endpointError,
                        Endpoint: endpointDisplay
                    )
                );
                continue;
            }

            var targetResult = await SendGuardAlertEventToTargetAsync(
                target.Name,
                endpointUri!,
                endpointDisplay,
                guardAlertEventJson,
                schemaVersion,
                eventType,
                cancellationToken
            );
            targetResults.Add(targetResult);
        }

        var sentCount = targetResults.Count(x => x.Status == "sent");
        var failedCount = targetResults.Count(x => x.Status == "failed");
        var skippedCount = targetResults.Count(x => x.Status == "skipped");
        var ok = failedCount == 0 && sentCount > 0;
        var status = ok
            ? "sent"
            : failedCount > 0
                ? (sentCount > 0 ? "partial_failed" : "failed")
                : "no_target_configured";
        var message = ok
            ? $"guard alert dispatched ({sentCount} targets)"
            : status switch
            {
                "partial_failed" => $"guard alert partial failure (sent={sentCount}, failed={failedCount}, skipped={skippedCount})",
                "failed" => $"guard alert dispatch failed (failed={failedCount}, skipped={skippedCount})",
                "no_target_configured" => "guard alert dispatch skipped: no target configured",
                _ => "guard alert dispatch failed"
            };

        if (ok)
        {
            Console.WriteLine($"[guard-alert] {message}");
        }
        else
        {
            Console.Error.WriteLine($"[guard-alert] {message}");
        }

        return new GuardAlertDispatchResult(
            Ok: ok,
            Status: status,
            Message: message,
            SchemaVersion: schemaVersion,
            EventType: eventType,
            AttemptedAtUtc: attemptedAtUtc,
            Targets: targetResults
        );
    }

    private async Task<GuardAlertDispatchTargetResult> SendGuardAlertEventToTargetAsync(
        string targetName,
        Uri endpointUri,
        string endpointDisplay,
        string guardAlertEventJson,
        string schemaVersion,
        string eventType,
        CancellationToken cancellationToken
    )
    {
        var maxAttempts = Math.Max(1, _config.GuardAlertDispatchMaxAttempts);
        var timeoutMs = Math.Clamp(_config.GuardAlertDispatchTimeoutMs, 500, 120000);
        var lastError = "dispatch_failed";
        int? lastStatusCode = null;

        for (var attempt = 1; attempt <= maxAttempts; attempt += 1)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromMilliseconds(timeoutMs));

            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, endpointUri);
                request.Headers.TryAddWithoutValidation("X-OmniNode-Event-Type", eventType);
                request.Headers.TryAddWithoutValidation("X-OmniNode-Schema-Version", schemaVersion);
                request.Headers.TryAddWithoutValidation("X-OmniNode-Dispatch-Source", "websocket_gateway");
                request.Content = new StringContent(guardAlertEventJson, Encoding.UTF8, "application/json");

                using var response = await GuardAlertPipelineHttpClient.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    timeoutCts.Token
                );
                lastStatusCode = (int)response.StatusCode;
                if (response.IsSuccessStatusCode)
                {
                    return new GuardAlertDispatchTargetResult(
                        Name: targetName,
                        Status: "sent",
                        Attempts: attempt,
                        StatusCode: lastStatusCode,
                        Error: "-",
                        Endpoint: endpointDisplay
                    );
                }

                var failureBody = await response.Content.ReadAsStringAsync(timeoutCts.Token);
                lastError = $"http_{lastStatusCode}";
                var detail = TrimTo(failureBody, 160).Trim();
                if (!string.IsNullOrWhiteSpace(detail))
                {
                    lastError = $"{lastError}: {detail}";
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                lastError = "timeout";
            }
            catch (Exception ex)
            {
                var detail = TrimTo(ex.Message, 160).Trim();
                lastError = string.IsNullOrWhiteSpace(detail) ? "request_exception" : detail;
            }

            if (attempt < maxAttempts)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(150 * attempt), cancellationToken);
            }
        }

        return new GuardAlertDispatchTargetResult(
            Name: targetName,
            Status: "failed",
            Attempts: maxAttempts,
            StatusCode: lastStatusCode,
            Error: lastError,
            Endpoint: endpointDisplay
        );
    }

    private static bool TryResolveGuardAlertEndpoint(
        string rawUrl,
        out Uri? endpointUri,
        out string endpointDisplay,
        out string error
    )
    {
        endpointUri = null;
        endpointDisplay = "-";
        error = "invalid_target_url";
        var normalized = (rawUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            error = "target_not_configured";
            return false;
        }

        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        {
            error = "invalid_target_url";
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            error = "invalid_target_scheme";
            return false;
        }

        endpointUri = uri;
        var builder = new UriBuilder(uri)
        {
            UserName = string.Empty,
            Password = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty
        };
        endpointDisplay = builder.Uri.ToString();
        if (endpointDisplay.EndsWith("/", StringComparison.Ordinal) && builder.Uri.AbsolutePath != "/")
        {
            endpointDisplay = endpointDisplay[..^1];
        }

        error = "-";
        return true;
    }

    private static string BuildGuardAlertDispatchResultJson(GuardAlertDispatchResult result)
    {
        var sentCount = result.Targets.Count(x => x.Status == "sent");
        var failedCount = result.Targets.Count(x => x.Status == "failed");
        var skippedCount = result.Targets.Count(x => x.Status == "skipped");
        var builder = new StringBuilder(512);
        builder.Append("{");
        builder.Append($"\"type\":\"{GuardAlertDispatchResultType}\",");
        builder.Append($"\"ok\":{(result.Ok ? "true" : "false")},");
        builder.Append($"\"status\":\"{EscapeJson(result.Status)}\",");
        builder.Append($"\"message\":\"{EscapeJson(result.Message)}\",");
        builder.Append($"\"schemaVersion\":\"{EscapeJson(result.SchemaVersion)}\",");
        builder.Append($"\"eventType\":\"{EscapeJson(result.EventType)}\",");
        builder.Append($"\"attemptedAtUtc\":\"{EscapeJson(result.AttemptedAtUtc)}\",");
        builder.Append($"\"sentCount\":{sentCount},");
        builder.Append($"\"failedCount\":{failedCount},");
        builder.Append($"\"skippedCount\":{skippedCount},");
        builder.Append("\"targets\":[");
        for (var i = 0; i < result.Targets.Count; i += 1)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var target = result.Targets[i];
            builder.Append("{");
            builder.Append($"\"name\":\"{EscapeJson(target.Name)}\",");
            builder.Append($"\"status\":\"{EscapeJson(target.Status)}\",");
            builder.Append($"\"attempts\":{Math.Max(0, target.Attempts)},");
            builder.Append($"\"statusCode\":{(target.StatusCode.HasValue ? target.StatusCode.Value.ToString(CultureInfo.InvariantCulture) : "null")},");
            builder.Append($"\"error\":\"{EscapeJson(target.Error)}\",");
            builder.Append($"\"endpoint\":\"{EscapeJson(target.Endpoint)}\"");
            builder.Append("}");
        }

        builder.Append("]}");
        return builder.ToString();
    }

    private bool TryResolveStaticAsset(string path, out string filePath, out string contentType)
    {
        var normalized = path switch
        {
            "/" => "index.html",
            "/index.html" => "index.html",
            "/app.js" => "app.js",
            "/worker.js" => "worker.js",
            "/styles.css" => "styles.css",
            _ => string.Empty
        };

        if (string.IsNullOrEmpty(normalized))
        {
            filePath = string.Empty;
            contentType = "text/plain";
            return false;
        }

        filePath = Path.Combine(_dashboardRootPath, normalized);
        contentType = normalized.EndsWith(".js", StringComparison.Ordinal)
            ? "application/javascript; charset=utf-8"
            : normalized.EndsWith(".css", StringComparison.Ordinal)
                ? "text/css; charset=utf-8"
                : "text/html; charset=utf-8";
        return true;
    }

    private static async Task WriteResponseAsync(
        HttpListenerResponse response,
        string contentType,
        string body,
        CancellationToken cancellationToken
    )
    {
        response.ContentType = contentType;
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["X-Frame-Options"] = "DENY";
        var bytes = Encoding.UTF8.GetBytes(body);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes, cancellationToken);
        response.OutputStream.Close();
    }

    private async Task<string?> ReceiveTextAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        var total = 0;
        using var ms = new MemoryStream();

        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            total += result.Count;
            if (total > _config.WebSocketMaxMessageBytes)
            {
                throw new InvalidOperationException($"payload too large (max={_config.WebSocketMaxMessageBytes})");
            }

            ms.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                break;
            }
        }

        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static async Task SendTextAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string text,
        CancellationToken cancellationToken
    )
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        await sendLock.WaitAsync(cancellationToken);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
            }
        }
        finally
        {
            sendLock.Release();
        }
    }

    private static bool LooksLikeJson(string text)
    {
        var trimmed = text.TrimStart();
        return trimmed.StartsWith("{", StringComparison.Ordinal) || trimmed.StartsWith("[", StringComparison.Ordinal);
    }

    private static TimeSpan ResolveTrustedAuthTtl(int? authTtlHours)
    {
        var hours = authTtlHours ?? DefaultTrustedAuthTtlHours;
        if (hours < MinTrustedAuthTtlHours)
        {
            hours = MinTrustedAuthTtlHours;
        }
        else if (hours > MaxTrustedAuthTtlHours)
        {
            hours = MaxTrustedAuthTtlHours;
        }

        return TimeSpan.FromHours(hours);
    }

    private static ClientMessage? ParseClientMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (!doc.RootElement.TryGetProperty("type", out var typeElement))
            {
                return null;
            }

            var type = typeElement.GetString();
            if (string.IsNullOrWhiteSpace(type))
            {
                return null;
            }

            string? otp = null;
            string? authToken = null;
            string? text = null;
            string? message = null;
            string? query = null;
            string? search = null;
            string? freshness = null;
            string? memoryPath = null;
            string? webFetchUrl = null;
            string? extractMode = null;
            string? model = null;
            string? provider = null;
            string? groqModel = null;
            string? geminiModel = null;
            string? copilotModel = null;
            string? cerebrasModel = null;
            string? summaryProvider = null;
            string? action = null;
            string? jobId = null;
            string? cronId = null;
            string? runMode = null;
            string? target = null;
            string? targetId = null;
            string? node = null;
            string? requestId = null;
            string? title = null;
            string? body = null;
            string? priority = null;
            string? delivery = null;
            string? invokeCommand = null;
            string? invokeParamsJson = null;
            string? spawnTask = null;
            string? label = null;
            string? runtime = null;
            string? sessionKey = null;
            string? scope = null;
            string? mode = null;
            string? profile = null;
            string? outputFormat = null;
            string? conversationId = null;
            string? conversationTitle = null;
            string? project = null;
            string? category = null;
            string? language = null;
            string? noteName = null;
            string? filePath = null;
            string? routineId = null;
            string? telegramBotToken = null;
            string? telegramChatId = null;
            string? groqApiKey = null;
            string? geminiApiKey = null;
            string? cerebrasApiKey = null;
            int? authTtlHours = null;
            int? timeoutSeconds = null;
            int? runTimeoutSeconds = null;
            int? limit = null;
            int? offset = null;
            int? count = null;
            int? activeMinutes = null;
            int? messageLimit = null;
            int? maxResults = null;
            int? maxChars = null;
            int? maxWidth = null;
            double? minScore = null;
            int? fromLine = null;
            int? lines = null;
            bool? enabled = null;
            bool? compactConversation = null;
            bool? includeDisabled = null;
            bool? includeTools = null;
            bool? thread = null;
            var attachments = new List<InputAttachment>();
            var memoryNotes = new List<string>();
            var tags = new List<string>();
            var kinds = new List<string>();
            var webUrls = new List<string>();
            var webSearchEnabled = true;
            var persist = false;

            if (doc.RootElement.TryGetProperty("otp", out var otpElement))
            {
                otp = otpElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("authToken", out var authTokenElement))
            {
                authToken = authTokenElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("text", out var textElement))
            {
                text = textElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("message", out var messageElement))
            {
                message = messageElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("query", out var queryElement))
            {
                query = queryElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("search", out var searchElement))
            {
                search = searchElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("freshness", out var freshnessElement))
            {
                freshness = freshnessElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("url", out var webFetchUrlElement))
            {
                webFetchUrl = webFetchUrlElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("extractMode", out var extractModeElement))
            {
                extractMode = extractModeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("path", out var pathElement))
            {
                memoryPath = pathElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("model", out var modelElement))
            {
                model = modelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("provider", out var providerElement))
            {
                provider = providerElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("groqModel", out var groqModelElement))
            {
                groqModel = groqModelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("geminiModel", out var geminiModelElement))
            {
                geminiModel = geminiModelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("copilotModel", out var copilotModelElement))
            {
                copilotModel = copilotModelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("cerebrasModel", out var cerebrasModelElement))
            {
                cerebrasModel = cerebrasModelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("summaryProvider", out var summaryProviderElement))
            {
                summaryProvider = summaryProviderElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("action", out var actionElement))
            {
                action = actionElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("jobId", out var jobIdElement))
            {
                jobId = jobIdElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("id", out var idElement))
            {
                cronId = idElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("runMode", out var runModeElement))
            {
                runMode = runModeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("target", out var targetElement))
            {
                target = targetElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("targetId", out var targetIdElement))
            {
                targetId = targetIdElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("node", out var nodeElement))
            {
                node = nodeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("requestId", out var requestIdElement))
            {
                requestId = requestIdElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("title", out var titleElement))
            {
                title = titleElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("body", out var bodyElement))
            {
                body = bodyElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("priority", out var priorityElement))
            {
                priority = priorityElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("delivery", out var deliveryElement))
            {
                delivery = deliveryElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("invokeCommand", out var invokeCommandElement))
            {
                invokeCommand = invokeCommandElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("invokeParamsJson", out var invokeParamsElement))
            {
                if (invokeParamsElement.ValueKind == JsonValueKind.String)
                {
                    invokeParamsJson = invokeParamsElement.GetString();
                }
                else
                {
                    invokeParamsJson = invokeParamsElement.GetRawText();
                }
            }

            if (doc.RootElement.TryGetProperty("task", out var taskElement))
            {
                spawnTask = taskElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("label", out var labelElement))
            {
                label = labelElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("runtime", out var runtimeElement))
            {
                runtime = runtimeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("sessionKey", out var sessionKeyElement))
            {
                sessionKey = sessionKeyElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("scope", out var scopeElement))
            {
                scope = scopeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("mode", out var modeElement))
            {
                mode = modeElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("profile", out var profileElement))
            {
                profile = profileElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("outputFormat", out var outputFormatElement))
            {
                outputFormat = outputFormatElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("conversationId", out var conversationIdElement))
            {
                conversationId = conversationIdElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("conversationTitle", out var conversationTitleElement))
            {
                conversationTitle = conversationTitleElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("project", out var projectElement))
            {
                project = projectElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("category", out var categoryElement))
            {
                category = categoryElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("tags", out var tagsElement)
                && tagsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in tagsElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    var value = item.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        tags.Add(value.Trim());
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("kinds", out var kindsElement)
                && kindsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in kindsElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    var value = item.GetString();
                    if (string.IsNullOrWhiteSpace(value))
                    {
                        continue;
                    }

                    kinds.Add(value.Trim());
                    if (kinds.Count >= 16)
                    {
                        break;
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("language", out var languageElement))
            {
                language = languageElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("noteName", out var noteNameElement))
            {
                noteName = noteNameElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("filePath", out var filePathElement))
            {
                filePath = filePathElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("routineId", out var routineIdElement))
            {
                routineId = routineIdElement.GetString();
            }

            if (doc.RootElement.TryGetProperty("memoryNotes", out var memoryNotesElement)
                && memoryNotesElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in memoryNotesElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    var value = item.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        memoryNotes.Add(value.Trim());
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("webUrls", out var webUrlsElement)
                && webUrlsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in webUrlsElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    var value = item.GetString();
                    if (string.IsNullOrWhiteSpace(value))
                    {
                        continue;
                    }

                    var normalized = value.Trim();
                    if (normalized.Length > 512)
                    {
                        normalized = normalized[..512];
                    }

                    webUrls.Add(normalized);
                    if (webUrls.Count >= 8)
                    {
                        break;
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("webSearchEnabled", out var webSearchElement))
            {
                if (webSearchElement.ValueKind == JsonValueKind.False)
                {
                    webSearchEnabled = false;
                }
                else if (webSearchElement.ValueKind == JsonValueKind.True)
                {
                    webSearchEnabled = true;
                }
            }

            if (doc.RootElement.TryGetProperty("attachments", out var attachmentsElement)
                && attachmentsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in attachmentsElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    var name = item.TryGetProperty("name", out var nameElement) && nameElement.ValueKind == JsonValueKind.String
                        ? (nameElement.GetString() ?? string.Empty).Trim()
                        : string.Empty;
                    var mimeType = item.TryGetProperty("mimeType", out var mimeElement) && mimeElement.ValueKind == JsonValueKind.String
                        ? (mimeElement.GetString() ?? string.Empty).Trim()
                        : "application/octet-stream";
                    var dataBase64 = item.TryGetProperty("dataBase64", out var dataElement) && dataElement.ValueKind == JsonValueKind.String
                        ? (dataElement.GetString() ?? string.Empty).Trim()
                        : string.Empty;
                    if (string.IsNullOrWhiteSpace(dataBase64))
                    {
                        continue;
                    }

                    long sizeBytes = 0;
                    if (item.TryGetProperty("sizeBytes", out var sizeElement))
                    {
                        if (sizeElement.ValueKind == JsonValueKind.Number && sizeElement.TryGetInt64(out var parsedLong))
                        {
                            sizeBytes = parsedLong;
                        }
                        else if (sizeElement.ValueKind == JsonValueKind.String
                                 && long.TryParse(sizeElement.GetString(), out var parsedString))
                        {
                            sizeBytes = parsedString;
                        }
                    }

                    var isImage = item.TryGetProperty("isImage", out var isImageElement)
                                  && isImageElement.ValueKind == JsonValueKind.True;
                    if (dataBase64.Length > 700_000)
                    {
                        dataBase64 = dataBase64[..700_000];
                    }

                    attachments.Add(new InputAttachment(name, mimeType, dataBase64, sizeBytes, isImage));
                    if (attachments.Count >= 6)
                    {
                        break;
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("telegramBotToken", out var tBot))
            {
                telegramBotToken = tBot.GetString();
            }

            if (doc.RootElement.TryGetProperty("telegramChatId", out var tChat))
            {
                telegramChatId = tChat.GetString();
            }

            if (doc.RootElement.TryGetProperty("groqApiKey", out var gKey))
            {
                groqApiKey = gKey.GetString();
            }

            if (doc.RootElement.TryGetProperty("geminiApiKey", out var geKey))
            {
                geminiApiKey = geKey.GetString();
            }

            if (doc.RootElement.TryGetProperty("cerebrasApiKey", out var cerebrasKey))
            {
                cerebrasApiKey = cerebrasKey.GetString();
            }

            if (doc.RootElement.TryGetProperty("persist", out var persistElement) && persistElement.ValueKind == JsonValueKind.True)
            {
                persist = true;
            }

            if (doc.RootElement.TryGetProperty("enabled", out var enabledElement))
            {
                if (enabledElement.ValueKind == JsonValueKind.True)
                {
                    enabled = true;
                }
                else if (enabledElement.ValueKind == JsonValueKind.False)
                {
                    enabled = false;
                }
            }

            if (doc.RootElement.TryGetProperty("compactConversation", out var compactConversationElement))
            {
                if (compactConversationElement.ValueKind == JsonValueKind.True)
                {
                    compactConversation = true;
                }
                else if (compactConversationElement.ValueKind == JsonValueKind.False)
                {
                    compactConversation = false;
                }
            }

            if (doc.RootElement.TryGetProperty("includeTools", out var includeToolsElement))
            {
                if (includeToolsElement.ValueKind == JsonValueKind.True)
                {
                    includeTools = true;
                }
                else if (includeToolsElement.ValueKind == JsonValueKind.False)
                {
                    includeTools = false;
                }
            }

            if (doc.RootElement.TryGetProperty("includeDisabled", out var includeDisabledElement))
            {
                if (includeDisabledElement.ValueKind == JsonValueKind.True)
                {
                    includeDisabled = true;
                }
                else if (includeDisabledElement.ValueKind == JsonValueKind.False)
                {
                    includeDisabled = false;
                }
            }

            if (doc.RootElement.TryGetProperty("thread", out var threadElement))
            {
                if (threadElement.ValueKind == JsonValueKind.True)
                {
                    thread = true;
                }
                else if (threadElement.ValueKind == JsonValueKind.False)
                {
                    thread = false;
                }
            }

            if (doc.RootElement.TryGetProperty("authTtlHours", out var ttlElement))
            {
                if (ttlElement.ValueKind == JsonValueKind.Number && ttlElement.TryGetInt32(out var ttlInt))
                {
                    authTtlHours = ttlInt;
                }
                else if (ttlElement.ValueKind == JsonValueKind.String
                         && int.TryParse(ttlElement.GetString(), out var ttlParsed))
                {
                    authTtlHours = ttlParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("timeoutSeconds", out var timeoutSecondsElement))
            {
                if (timeoutSecondsElement.ValueKind == JsonValueKind.Number
                    && timeoutSecondsElement.TryGetInt32(out var timeoutSecondsInt))
                {
                    timeoutSeconds = timeoutSecondsInt;
                }
                else if (timeoutSecondsElement.ValueKind == JsonValueKind.String
                         && int.TryParse(
                             timeoutSecondsElement.GetString(),
                             NumberStyles.Integer,
                             CultureInfo.InvariantCulture,
                             out var timeoutSecondsParsed
                         ))
                {
                    timeoutSeconds = timeoutSecondsParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("runTimeoutSeconds", out var runTimeoutSecondsElement))
            {
                if (runTimeoutSecondsElement.ValueKind == JsonValueKind.Number
                    && runTimeoutSecondsElement.TryGetInt32(out var runTimeoutSecondsInt))
                {
                    runTimeoutSeconds = runTimeoutSecondsInt;
                }
                else if (runTimeoutSecondsElement.ValueKind == JsonValueKind.String
                         && int.TryParse(
                             runTimeoutSecondsElement.GetString(),
                             NumberStyles.Integer,
                             CultureInfo.InvariantCulture,
                             out var runTimeoutSecondsParsed
                         ))
                {
                    runTimeoutSeconds = runTimeoutSecondsParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("limit", out var limitElement))
            {
                if (limitElement.ValueKind == JsonValueKind.Number && limitElement.TryGetInt32(out var limitInt))
                {
                    limit = limitInt;
                }
                else if (limitElement.ValueKind == JsonValueKind.String
                         && int.TryParse(limitElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var limitParsed))
                {
                    limit = limitParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("offset", out var offsetElement))
            {
                if (offsetElement.ValueKind == JsonValueKind.Number && offsetElement.TryGetInt32(out var offsetInt))
                {
                    offset = offsetInt;
                }
                else if (offsetElement.ValueKind == JsonValueKind.String
                         && int.TryParse(offsetElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var offsetParsed))
                {
                    offset = offsetParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("maxResults", out var maxResultsElement))
            {
                if (maxResultsElement.ValueKind == JsonValueKind.Number && maxResultsElement.TryGetInt32(out var maxResultsInt))
                {
                    maxResults = maxResultsInt;
                }
                else if (maxResultsElement.ValueKind == JsonValueKind.String
                         && int.TryParse(maxResultsElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxResultsParsed))
                {
                    maxResults = maxResultsParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("activeMinutes", out var activeMinutesElement))
            {
                if (activeMinutesElement.ValueKind == JsonValueKind.Number && activeMinutesElement.TryGetInt32(out var activeMinutesInt))
                {
                    activeMinutes = activeMinutesInt;
                }
                else if (activeMinutesElement.ValueKind == JsonValueKind.String
                         && int.TryParse(activeMinutesElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var activeMinutesParsed))
                {
                    activeMinutes = activeMinutesParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("messageLimit", out var messageLimitElement))
            {
                if (messageLimitElement.ValueKind == JsonValueKind.Number && messageLimitElement.TryGetInt32(out var messageLimitInt))
                {
                    messageLimit = messageLimitInt;
                }
                else if (messageLimitElement.ValueKind == JsonValueKind.String
                         && int.TryParse(messageLimitElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var messageLimitParsed))
                {
                    messageLimit = messageLimitParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("maxChars", out var maxCharsElement))
            {
                if (maxCharsElement.ValueKind == JsonValueKind.Number && maxCharsElement.TryGetInt32(out var maxCharsInt))
                {
                    maxChars = maxCharsInt;
                }
                else if (maxCharsElement.ValueKind == JsonValueKind.String
                         && int.TryParse(maxCharsElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxCharsParsed))
                {
                    maxChars = maxCharsParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("maxWidth", out var maxWidthElement))
            {
                if (maxWidthElement.ValueKind == JsonValueKind.Number && maxWidthElement.TryGetInt32(out var maxWidthInt))
                {
                    maxWidth = maxWidthInt;
                }
                else if (maxWidthElement.ValueKind == JsonValueKind.String
                         && int.TryParse(maxWidthElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxWidthParsed))
                {
                    maxWidth = maxWidthParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("count", out var countElement))
            {
                if (countElement.ValueKind == JsonValueKind.Number && countElement.TryGetInt32(out var countInt))
                {
                    count = countInt;
                }
                else if (countElement.ValueKind == JsonValueKind.String
                         && int.TryParse(countElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var countParsed))
                {
                    count = countParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("minScore", out var minScoreElement))
            {
                if (minScoreElement.ValueKind == JsonValueKind.Number && minScoreElement.TryGetDouble(out var minScoreDouble))
                {
                    minScore = minScoreDouble;
                }
                else if (minScoreElement.ValueKind == JsonValueKind.String
                         && double.TryParse(
                             minScoreElement.GetString(),
                             NumberStyles.Float | NumberStyles.AllowThousands,
                             CultureInfo.InvariantCulture,
                             out var minScoreParsed
                         ))
                {
                    minScore = minScoreParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("from", out var fromElement))
            {
                if (fromElement.ValueKind == JsonValueKind.Number && fromElement.TryGetInt32(out var fromInt))
                {
                    fromLine = fromInt;
                }
                else if (fromElement.ValueKind == JsonValueKind.String
                         && int.TryParse(fromElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var fromParsed))
                {
                    fromLine = fromParsed;
                }
            }

            if (doc.RootElement.TryGetProperty("lines", out var linesElement))
            {
                if (linesElement.ValueKind == JsonValueKind.Number && linesElement.TryGetInt32(out var linesInt))
                {
                    lines = linesInt;
                }
                else if (linesElement.ValueKind == JsonValueKind.String
                         && int.TryParse(linesElement.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var linesParsed))
                {
                    lines = linesParsed;
                }
            }

            return new ClientMessage
            {
                RawJson = json,
                Type = type,
                Otp = otp,
                AuthToken = authToken,
                Text = text,
                Message = message,
                Query = query,
                Search = search,
                Freshness = freshness,
                MemoryPath = memoryPath,
                WebFetchUrl = webFetchUrl,
                ExtractMode = extractMode,
                Model = model,
                Provider = provider,
                GroqModel = groqModel,
                GeminiModel = geminiModel,
                CopilotModel = copilotModel,
                CerebrasModel = cerebrasModel,
                SummaryProvider = summaryProvider,
                Action = action,
                JobId = jobId,
                CronId = cronId,
                RunMode = runMode,
                Target = target,
                TargetId = targetId,
                Node = node,
                RequestId = requestId,
                Title = title,
                Body = body,
                Priority = priority,
                Delivery = delivery,
                InvokeCommand = invokeCommand,
                InvokeParamsJson = invokeParamsJson,
                SpawnTask = spawnTask,
                Label = label,
                Runtime = runtime,
                SessionKey = sessionKey,
                Scope = scope,
                Mode = mode,
                Profile = profile,
                OutputFormat = outputFormat,
                ConversationId = conversationId,
                ConversationTitle = conversationTitle,
                Project = project,
                Category = category,
                Language = language,
                NoteName = noteName,
                FilePath = filePath,
                RoutineId = routineId,
                TelegramBotToken = telegramBotToken,
                TelegramChatId = telegramChatId,
                GroqApiKey = groqApiKey,
                GeminiApiKey = geminiApiKey,
                CerebrasApiKey = cerebrasApiKey,
                AuthTtlHours = authTtlHours,
                TimeoutSeconds = timeoutSeconds,
                RunTimeoutSeconds = runTimeoutSeconds,
                Limit = limit,
                Offset = offset,
                Count = count,
                ActiveMinutes = activeMinutes,
                MessageLimit = messageLimit,
                MaxResults = maxResults,
                MaxChars = maxChars,
                MaxWidth = maxWidth,
                MinScore = minScore,
                FromLine = fromLine,
                Lines = lines,
                Enabled = enabled,
                CompactConversation = compactConversation,
                IncludeDisabled = includeDisabled,
                IncludeTools = includeTools,
                Thread = thread,
                Tags = tags.Count == 0 ? Array.Empty<string>() : tags.ToArray(),
                Kinds = kinds.Count == 0 ? Array.Empty<string>() : kinds.ToArray(),
                MemoryNotes = memoryNotes.Count == 0 ? Array.Empty<string>() : memoryNotes.ToArray(),
                Attachments = attachments.Count == 0 ? Array.Empty<InputAttachment>() : attachments.ToArray(),
                WebUrls = webUrls.Count == 0 ? Array.Empty<string>() : webUrls.ToArray(),
                WebSearchEnabled = webSearchEnabled,
                Persist = persist
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? BuildGuardAlertEventJson(string? rawJson)
    {
        var normalized = (rawJson ?? string.Empty).Trim();
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

            if (doc.RootElement.TryGetProperty("guardAlertEvent", out var guardAlertElement)
                && guardAlertElement.ValueKind == JsonValueKind.Object)
            {
                return guardAlertElement.GetRawText();
            }

            if (doc.RootElement.TryGetProperty("payload", out var payloadElement)
                && payloadElement.ValueKind == JsonValueKind.Object)
            {
                return payloadElement.GetRawText();
            }

            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? BuildCronAddJobJson(string? rawJson)
    {
        var normalized = (rawJson ?? string.Empty).Trim();
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
            if (root.TryGetProperty("job", out var jobElement)
                && jobElement.ValueKind == JsonValueKind.Object)
            {
                return jobElement.GetRawText();
            }

            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                var found = false;
                foreach (var property in root.EnumerateObject())
                {
                    if (!IsCronAddSyntheticJobField(property.Name))
                    {
                        continue;
                    }

                    writer.WritePropertyName(property.Name);
                    property.Value.WriteTo(writer);
                    found = true;
                }

                writer.WriteEndObject();
                writer.Flush();
                if (!found)
                {
                    return null;
                }
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? BuildCronUpdatePatchJson(string? rawJson)
    {
        var normalized = (rawJson ?? string.Empty).Trim();
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
            if (root.TryGetProperty("patch", out var patchElement)
                && patchElement.ValueKind == JsonValueKind.Object)
            {
                return patchElement.GetRawText();
            }

            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                var found = false;
                foreach (var property in root.EnumerateObject())
                {
                    if (!IsCronUpdateSyntheticPatchField(property.Name))
                    {
                        continue;
                    }

                    writer.WritePropertyName(property.Name);
                    property.Value.WriteTo(writer);
                    found = true;
                }

                writer.WriteEndObject();
                writer.Flush();
                if (!found)
                {
                    return null;
                }
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsCronAddSyntheticJobField(string name)
    {
        return name switch
        {
            "name" => true,
            "description" => true,
            "enabled" => true,
            "schedule" => true,
            "sessionTarget" => true,
            "wakeMode" => true,
            "payload" => true,
            "text" => true,
            "message" => true,
            "model" => true,
            "thinking" => true,
            "timeoutSeconds" => true,
            "lightContext" => true,
            _ => false
        };
    }

    private static bool IsCronUpdateSyntheticPatchField(string name)
    {
        return name switch
        {
            "name" => true,
            "description" => true,
            "enabled" => true,
            "schedule" => true,
            "sessionTarget" => true,
            "wakeMode" => true,
            "payload" => true,
            "text" => true,
            "message" => true,
            "model" => true,
            "thinking" => true,
            "timeoutSeconds" => true,
            "lightContext" => true,
            _ => false
        };
    }

    private static string EscapeJson(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length + 16);
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                default:
                    if (ch < ' ')
                    {
                        builder.Append("\\u");
                        builder.Append(((int)ch).ToString("x4"));
                    }
                    else if (ch == '\u2028')
                    {
                        builder.Append("\\u2028");
                    }
                    else if (ch == '\u2029')
                    {
                        builder.Append("\\u2029");
                    }
                    else
                    {
                        builder.Append(ch);
                    }

                    break;
            }
        }

        return builder.ToString();
    }

    private static string FormatLocalDateTime(DateTimeOffset utc)
    {
        return utc.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
    }

    private static string FormatUtcOffset(TimeSpan offset)
    {
        var sign = offset < TimeSpan.Zero ? "-" : "+";
        var abs = offset < TimeSpan.Zero ? offset.Negate() : offset;
        return $"UTC{sign}{abs:hh\\:mm}";
    }

    private sealed class ClientMessage
    {
        public string RawJson { get; set; } = string.Empty;
        public string? Type { get; set; }
        public string? Otp { get; set; }
        public string? AuthToken { get; set; }
        public string? Text { get; set; }
        public string? Message { get; set; }
        public string? Query { get; set; }
        public string? Search { get; set; }
        public string? Freshness { get; set; }
        public string? MemoryPath { get; set; }
        public string? WebFetchUrl { get; set; }
        public string? ExtractMode { get; set; }
        public string? Model { get; set; }
        public string? Provider { get; set; }
        public string? GroqModel { get; set; }
        public string? GeminiModel { get; set; }
        public string? CopilotModel { get; set; }
        public string? CerebrasModel { get; set; }
        public string? SummaryProvider { get; set; }
        public string? Action { get; set; }
        public string? JobId { get; set; }
        public string? CronId { get; set; }
        public string? RunMode { get; set; }
        public string? Target { get; set; }
        public string? TargetId { get; set; }
        public string? Node { get; set; }
        public string? RequestId { get; set; }
        public string? Title { get; set; }
        public string? Body { get; set; }
        public string? Priority { get; set; }
        public string? Delivery { get; set; }
        public string? InvokeCommand { get; set; }
        public string? InvokeParamsJson { get; set; }
        public string? SpawnTask { get; set; }
        public string? Label { get; set; }
        public string? Runtime { get; set; }
        public string? SessionKey { get; set; }
        public string? Scope { get; set; }
        public string? Mode { get; set; }
        public string? Profile { get; set; }
        public string? OutputFormat { get; set; }
        public string? ConversationId { get; set; }
        public string? ConversationTitle { get; set; }
        public string? Project { get; set; }
        public string? Category { get; set; }
        public string? Language { get; set; }
        public string? NoteName { get; set; }
        public string? FilePath { get; set; }
        public string? RoutineId { get; set; }
        public string? TelegramBotToken { get; set; }
        public string? TelegramChatId { get; set; }
        public string? GroqApiKey { get; set; }
        public string? GeminiApiKey { get; set; }
        public string? CerebrasApiKey { get; set; }
        public int? AuthTtlHours { get; set; }
        public int? TimeoutSeconds { get; set; }
        public int? RunTimeoutSeconds { get; set; }
        public int? Limit { get; set; }
        public int? Offset { get; set; }
        public int? Count { get; set; }
        public int? ActiveMinutes { get; set; }
        public int? MessageLimit { get; set; }
        public int? MaxResults { get; set; }
        public int? MaxChars { get; set; }
        public int? MaxWidth { get; set; }
        public double? MinScore { get; set; }
        public int? FromLine { get; set; }
        public int? Lines { get; set; }
        public bool? Enabled { get; set; }
        public bool? CompactConversation { get; set; }
        public bool? IncludeDisabled { get; set; }
        public bool? IncludeTools { get; set; }
        public bool? Thread { get; set; }
        public IReadOnlyList<string> Tags { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> Kinds { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> MemoryNotes { get; set; } = Array.Empty<string>();
        public IReadOnlyList<InputAttachment> Attachments { get; set; } = Array.Empty<InputAttachment>();
        public IReadOnlyList<string> WebUrls { get; set; } = Array.Empty<string>();
        public bool WebSearchEnabled { get; set; } = true;
        public bool Persist { get; set; }
    }

    private sealed record RateWindow(DateTimeOffset WindowStart, int Count);
}
