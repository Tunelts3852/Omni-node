using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed record SessionHistoryToolMessage(
    string Role,
    string Text,
    string CreatedUtc
);

public sealed record SessionHistoryToolResult(
    string SessionKey,
    string Status,
    string? Error,
    int Count,
    IReadOnlyList<SessionHistoryToolMessage> Messages,
    bool Truncated,
    bool DroppedMessages,
    bool ContentTruncated,
    bool ContentRedacted,
    int Bytes
);

public sealed class SessionHistoryTool
{
    private const int SessionsHistoryMaxBytes = 80 * 1024;
    private const int SessionsHistoryTextMaxChars = 4000;
    private static readonly Regex OpenAiTokenRegex = new("sk-[a-zA-Z0-9]{16,}", RegexOptions.Compiled);
    private static readonly Regex NamedSecretRegex = new(
        "(?i)\\b(api[_-]?key|token|secret|password)\\b\\s*[:=]\\s*[^\\s,;]+",
        RegexOptions.Compiled
    );

    private readonly ConversationStore _conversationStore;

    public SessionHistoryTool(ConversationStore conversationStore)
    {
        _conversationStore = conversationStore;
    }

    public SessionHistoryToolResult Get(string? sessionKey, int? limit = null, bool includeTools = false)
    {
        var normalizedSessionKey = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedSessionKey))
        {
            return ErrorResult(sessionKey, "sessionKey is required");
        }

        var conversation = _conversationStore.Get(normalizedSessionKey);
        if (conversation is null)
        {
            return ErrorResult(normalizedSessionKey, $"session not found: {normalizedSessionKey}");
        }

        var resolvedLimit = ResolveLimit(limit);
        var selectedMessages = conversation.Messages
            .OrderByDescending(x => x.CreatedUtc)
            .Take(resolvedLimit)
            .OrderBy(x => x.CreatedUtc)
            .Where(x => includeTools || !IsToolRole(x.Role))
            .ToArray();

        var contentTruncated = false;
        var contentRedacted = false;
        var sanitizedMessages = new List<SessionHistoryToolMessage>(selectedMessages.Length);
        foreach (var message in selectedMessages)
        {
            var sanitized = SanitizeText(message.Text);
            contentTruncated |= sanitized.Truncated;
            contentRedacted |= sanitized.Redacted;
            sanitizedMessages.Add(new SessionHistoryToolMessage(
                NormalizeRole(message.Role),
                sanitized.Text,
                message.CreatedUtc.ToString("O")
            ));
        }

        var capped = EnforceByteCap(sanitizedMessages);
        var truncated = contentTruncated || capped.DroppedMessages;
        return new SessionHistoryToolResult(
            normalizedSessionKey,
            "ok",
            null,
            capped.Messages.Count,
            capped.Messages,
            truncated,
            capped.DroppedMessages,
            contentTruncated,
            contentRedacted,
            capped.Bytes
        );
    }

    private static SessionHistoryToolResult ErrorResult(string? sessionKey, string error)
    {
        return new SessionHistoryToolResult(
            (sessionKey ?? string.Empty).Trim(),
            "error",
            error,
            0,
            Array.Empty<SessionHistoryToolMessage>(),
            false,
            false,
            false,
            false,
            2
        );
    }

    private static bool IsToolRole(string? role)
    {
        var normalized = (role ?? string.Empty).Trim().ToLowerInvariant();
        return normalized is "tool" or "toolresult";
    }

    private static string NormalizeRole(string? role)
    {
        var normalized = (role ?? string.Empty).Trim().ToLowerInvariant();
        return normalized is "user" or "assistant" or "system" ? normalized : "assistant";
    }

    private static int ResolveLimit(int? limit)
    {
        if (!limit.HasValue)
        {
            return 120;
        }

        return Math.Clamp(limit.Value, 1, 500);
    }

    private static SanitizedTextResult SanitizeText(string? text)
    {
        var value = text ?? string.Empty;
        var redacted = false;
        var truncated = false;

        var redactedText = OpenAiTokenRegex.Replace(value, match =>
        {
            redacted = true;
            return $"{match.Value[..3]}[redacted]";
        });

        redactedText = NamedSecretRegex.Replace(redactedText, match =>
        {
            redacted = true;
            var index = match.Value.IndexOfAny(new[] { ':', '=' });
            if (index < 0)
            {
                return "[redacted]";
            }

            return $"{match.Value[..(index + 1)]} [redacted]";
        });

        if (redactedText.Length > SessionsHistoryTextMaxChars)
        {
            redactedText = redactedText[..SessionsHistoryTextMaxChars] + "\n...(truncated)...";
            truncated = true;
        }

        return new SanitizedTextResult(redactedText, truncated, redacted);
    }

    private static ByteCapResult EnforceByteCap(IReadOnlyList<SessionHistoryToolMessage> messages)
    {
        var items = messages.ToList();
        var bytes = CalculateJsonUtf8Bytes(items);
        var droppedMessages = false;

        while (bytes > SessionsHistoryMaxBytes && items.Count > 0)
        {
            droppedMessages = true;
            items.RemoveAt(0);
            bytes = CalculateJsonUtf8Bytes(items);
        }

        if (bytes <= SessionsHistoryMaxBytes)
        {
            return new ByteCapResult(items.ToArray(), bytes, droppedMessages);
        }

        var placeholder = new[]
        {
            new SessionHistoryToolMessage(
                "assistant",
                "[sessions_history omitted: message too large]",
                DateTimeOffset.UtcNow.ToString("O")
            )
        };
        return new ByteCapResult(
            placeholder,
            CalculateJsonUtf8Bytes(placeholder),
            true
        );
    }

    private static int CalculateJsonUtf8Bytes(IReadOnlyList<SessionHistoryToolMessage> messages)
    {
        var builder = new StringBuilder();
        builder.Append("[");
        for (var i = 0; i < messages.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }

            var message = messages[i];
            builder.Append("{");
            builder.Append($"\"role\":\"{EscapeJson(message.Role)}\",");
            builder.Append($"\"text\":\"{EscapeJson(message.Text)}\",");
            builder.Append($"\"createdUtc\":\"{EscapeJson(message.CreatedUtc)}\"");
            builder.Append("}");
        }

        builder.Append("]");
        return Encoding.UTF8.GetByteCount(builder.ToString());
    }

    private static string EscapeJson(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
    }

    private readonly record struct SanitizedTextResult(string Text, bool Truncated, bool Redacted);
    private readonly record struct ByteCapResult(IReadOnlyList<SessionHistoryToolMessage> Messages, int Bytes, bool DroppedMessages);
}
