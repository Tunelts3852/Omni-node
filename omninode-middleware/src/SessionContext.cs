namespace OmniNode.Middleware;

public sealed record SessionContext(
    string AgentId,
    string SessionId,
    string SessionKey,
    string Scope,
    string Mode,
    string Source,
    ConversationThreadView Thread,
    IReadOnlyList<string> LinkedMemoryNotes
)
{
    public static SessionContext Create(
        ConversationThreadView thread,
        string? source,
        string? agentId = null
    )
    {
        var resolvedAgentId = NormalizeToken(agentId, "main");
        var resolvedSessionId = NormalizeSessionId(thread.Id);
        var resolvedScope = NormalizeToken(thread.Scope, "chat");
        var resolvedMode = NormalizeToken(thread.Mode, "single");
        var resolvedSource = NormalizeToken(source, "unknown");
        var resolvedSessionKey = $"agent:{resolvedAgentId}:{resolvedScope}:{resolvedMode}:{resolvedSessionId}";
        var resolvedNotes = NormalizeMemoryNotes(thread.LinkedMemoryNotes);

        return new SessionContext(
            resolvedAgentId,
            resolvedSessionId,
            resolvedSessionKey,
            resolvedScope,
            resolvedMode,
            resolvedSource,
            thread,
            resolvedNotes
        );
    }

    private static string NormalizeSessionId(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? "unknown"
            : value.Trim().ToLowerInvariant();
    }

    private static string NormalizeToken(string? value, string fallback)
    {
        var trimmed = (value ?? string.Empty).Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(trimmed) ? fallback : trimmed;
    }

    private static IReadOnlyList<string> NormalizeMemoryNotes(IReadOnlyList<string>? notes)
    {
        if (notes == null || notes.Count == 0)
        {
            return Array.Empty<string>();
        }

        return notes
            .Where(note => !string.IsNullOrWhiteSpace(note))
            .Select(note => note.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }
}
