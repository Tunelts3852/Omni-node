namespace OmniNode.Middleware;

public sealed record SessionSendToolResult(
    string SessionKey,
    string Status,
    string? Error,
    string RunId,
    string? Reply,
    int TimeoutSeconds,
    bool MessageTruncated
);

public sealed class SessionSendTool
{
    private const int SessionsSendMessageMaxChars = 4000;
    private readonly ConversationStore _conversationStore;

    public SessionSendTool(ConversationStore conversationStore)
    {
        _conversationStore = conversationStore;
    }

    public SessionSendToolResult Send(string? sessionKey, string? message, int? timeoutSeconds = null)
    {
        var runId = Guid.NewGuid().ToString("N");
        var normalizedSessionKey = (sessionKey ?? string.Empty).Trim();
        var resolvedTimeoutSeconds = ResolveTimeoutSeconds(timeoutSeconds);
        if (string.IsNullOrWhiteSpace(normalizedSessionKey))
        {
            return ErrorResult(
                sessionKey,
                "sessionKey is required",
                runId,
                resolvedTimeoutSeconds
            );
        }

        var normalizedMessage = (message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedMessage))
        {
            return ErrorResult(
                normalizedSessionKey,
                "message is required",
                runId,
                resolvedTimeoutSeconds
            );
        }

        var conversation = _conversationStore.Get(normalizedSessionKey);
        if (conversation is null)
        {
            return ErrorResult(
                normalizedSessionKey,
                $"session not found: {normalizedSessionKey}",
                runId,
                resolvedTimeoutSeconds
            );
        }

        var messageTruncated = false;
        if (normalizedMessage.Length > SessionsSendMessageMaxChars)
        {
            normalizedMessage = normalizedMessage[..SessionsSendMessageMaxChars] + "\n...(truncated)...";
            messageTruncated = true;
        }

        var updated = _conversationStore.AppendMessage(
            normalizedSessionKey,
            "user",
            normalizedMessage,
            "sessions_send"
        );
        if (resolvedTimeoutSeconds == 0)
        {
            return new SessionSendToolResult(
                normalizedSessionKey,
                "accepted",
                null,
                runId,
                null,
                resolvedTimeoutSeconds,
                messageTruncated
            );
        }

        var reply = updated.Messages
            .Where(x => x.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase))
            .Select(x => (x.Text ?? string.Empty).Trim())
            .LastOrDefault(x => !string.IsNullOrWhiteSpace(x));

        return new SessionSendToolResult(
            normalizedSessionKey,
            "ok",
            null,
            runId,
            reply,
            resolvedTimeoutSeconds,
            messageTruncated
        );
    }

    private static int ResolveTimeoutSeconds(int? timeoutSeconds)
    {
        if (!timeoutSeconds.HasValue)
        {
            return 30;
        }

        return Math.Clamp(timeoutSeconds.Value, 0, 300);
    }

    private static SessionSendToolResult ErrorResult(
        string? sessionKey,
        string error,
        string runId,
        int timeoutSeconds
    )
    {
        return new SessionSendToolResult(
            (sessionKey ?? string.Empty).Trim(),
            "error",
            error,
            runId,
            null,
            timeoutSeconds,
            false
        );
    }
}
