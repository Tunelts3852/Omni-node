namespace OmniNode.Middleware;

public sealed record SessionListToolMessage(
    string Role,
    string Text,
    string CreatedUtc
);

public sealed record SessionListToolSession(
    string Key,
    string Kind,
    string Scope,
    string Mode,
    string Label,
    string DisplayName,
    string Project,
    string Category,
    IReadOnlyList<string> Tags,
    long UpdatedAt,
    int MessageCount,
    string Preview,
    IReadOnlyList<string> LinkedMemoryNotes,
    IReadOnlyList<SessionListToolMessage> Messages
);

public sealed record SessionListToolResult(
    int Count,
    IReadOnlyList<SessionListToolSession> Sessions
);

public sealed class SessionListTool
{
    private static readonly HashSet<string> SupportedKinds = new(StringComparer.OrdinalIgnoreCase)
    {
        "main",
        "other"
    };

    private readonly ConversationStore _conversationStore;

    public SessionListTool(ConversationStore conversationStore)
    {
        _conversationStore = conversationStore;
    }

    public SessionListToolResult List(
        IReadOnlyList<string>? kinds = null,
        int? limit = null,
        int? activeMinutes = null,
        int? messageLimit = null,
        string? search = null,
        string? scope = null,
        string? mode = null
    )
    {
        var allowedKinds = BuildAllowedKinds(kinds);
        var normalizedSearch = NormalizeSearch(search);
        var resolvedLimit = ResolveLimit(limit);
        var resolvedMessageLimit = ResolveMessageLimit(messageLimit);
        var activeMinutesCutoffUtc = ResolveActiveMinutesCutoffUtc(activeMinutes);

        IReadOnlyList<ConversationThreadSummary> baseRows;
        if (!string.IsNullOrWhiteSpace(scope) || !string.IsNullOrWhiteSpace(mode))
        {
            baseRows = _conversationStore.List(scope ?? "chat", mode ?? "single");
        }
        else
        {
            baseRows = _conversationStore.ListAll();
        }

        var filtered = new List<ConversationThreadSummary>(baseRows.Count);
        foreach (var row in baseRows)
        {
            var kind = ResolveKind(row.Scope, row.Mode);
            if (allowedKinds is not null && !allowedKinds.Contains(kind))
            {
                continue;
            }

            if (activeMinutesCutoffUtc.HasValue && row.UpdatedUtc < activeMinutesCutoffUtc.Value)
            {
                continue;
            }

            if (!MatchesSearch(row, normalizedSearch))
            {
                continue;
            }

            filtered.Add(row);
            if (filtered.Count >= resolvedLimit)
            {
                break;
            }
        }

        var sessions = new List<SessionListToolSession>(filtered.Count);
        foreach (var row in filtered)
        {
            sessions.Add(ToSession(row, resolvedMessageLimit));
        }

        return new SessionListToolResult(
            sessions.Count,
            sessions
        );
    }

    private SessionListToolSession ToSession(ConversationThreadSummary row, int messageLimit)
    {
        var messages = Array.Empty<SessionListToolMessage>();
        if (messageLimit > 0)
        {
            var conversation = _conversationStore.Get(row.Id);
            if (conversation is not null && conversation.Messages.Count > 0)
            {
                messages = conversation.Messages
                    .TakeLast(messageLimit)
                    .Select(x => new SessionListToolMessage(
                        x.Role,
                        x.Text,
                        x.CreatedUtc.ToString("O")
                    ))
                    .ToArray();
            }
        }

        return new SessionListToolSession(
            row.Id,
            ResolveKind(row.Scope, row.Mode),
            row.Scope,
            row.Mode,
            row.Title,
            row.Title,
            row.Project,
            row.Category,
            row.Tags,
            row.UpdatedUtc.ToUnixTimeMilliseconds(),
            row.MessageCount,
            row.Preview,
            row.LinkedMemoryNotes,
            messages
        );
    }

    private static HashSet<string>? BuildAllowedKinds(IReadOnlyList<string>? kinds)
    {
        if (kinds is null || kinds.Count == 0)
        {
            return null;
        }

        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in kinds)
        {
            var value = (item ?? string.Empty).Trim().ToLowerInvariant();
            if (SupportedKinds.Contains(value))
            {
                set.Add(value);
            }
        }

        return set.Count == 0 ? null : set;
    }

    private static string? NormalizeSearch(string? search)
    {
        var value = (search ?? string.Empty).Trim().ToLowerInvariant();
        return value.Length == 0 ? null : value;
    }

    private static int ResolveLimit(int? limit)
    {
        if (!limit.HasValue)
        {
            return 50;
        }

        return Math.Clamp(limit.Value, 1, 200);
    }

    private static int ResolveMessageLimit(int? messageLimit)
    {
        if (!messageLimit.HasValue)
        {
            return 0;
        }

        return Math.Clamp(messageLimit.Value, 0, 20);
    }

    private static DateTimeOffset? ResolveActiveMinutesCutoffUtc(int? activeMinutes)
    {
        if (!activeMinutes.HasValue)
        {
            return null;
        }

        var minutes = Math.Clamp(activeMinutes.Value, 1, 43_200);
        return DateTimeOffset.UtcNow.AddMinutes(-minutes);
    }

    private static bool MatchesSearch(ConversationThreadSummary row, string? search)
    {
        if (string.IsNullOrWhiteSpace(search))
        {
            return true;
        }

        return ContainsIgnoreCase(row.Id, search)
               || ContainsIgnoreCase(row.Title, search)
               || ContainsIgnoreCase(row.Project, search)
               || ContainsIgnoreCase(row.Category, search)
               || ContainsIgnoreCase(row.Preview, search)
               || row.Tags.Any(x => ContainsIgnoreCase(x, search));
    }

    private static bool ContainsIgnoreCase(string? value, string search)
    {
        return !string.IsNullOrWhiteSpace(value)
               && value.Contains(search, StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveKind(string scope, string mode)
    {
        var normalizedScope = (scope ?? string.Empty).Trim().ToLowerInvariant();
        var normalizedMode = (mode ?? string.Empty).Trim().ToLowerInvariant();
        return normalizedScope == "chat" && normalizedMode == "single"
            ? "main"
            : "other";
    }
}
