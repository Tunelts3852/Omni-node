namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    public IReadOnlyList<ConversationThreadSummary> ListConversations(string scope, string mode)
    {
        return _conversationStore.List(scope, mode);
    }

    public ConversationThreadView CreateConversation(
        string scope,
        string mode,
        string? title,
        string? project,
        string? category,
        IReadOnlyList<string>? tags
    )
    {
        return _conversationStore.Create(scope, mode, title, project, category, tags);
    }

    public ConversationThreadView? GetConversation(string conversationId)
    {
        return _conversationStore.Get(conversationId);
    }

    public bool DeleteConversation(string conversationId)
    {
        var targetConversationId = (conversationId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(targetConversationId))
        {
            return false;
        }

        var thread = _conversationStore.Get(targetConversationId);
        if (thread == null)
        {
            return false;
        }

        var linkedNotes = thread.LinkedMemoryNotes
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => name.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var deleted = _conversationStore.Delete(targetConversationId);
        if (!deleted)
        {
            return false;
        }

        _auditLogger.Log(
            "web",
            "delete_conversation",
            "ok",
            $"conversationId={NormalizeAuditToken(targetConversationId, "-")} linkedNotes={linkedNotes.Length} removedNotes=0"
        );
        return true;
    }

    public ConversationThreadView UpdateConversationMetadata(
        string conversationId,
        string? conversationTitle,
        string? project,
        string? category,
        IReadOnlyList<string>? tags
    )
    {
        var targetConversationId = (conversationId ?? string.Empty).Trim();
        var before = _conversationStore.Get(targetConversationId)
            ?? throw new InvalidOperationException("conversation not found");
        var updated = _conversationStore.UpdateMetadata(
            targetConversationId,
            conversationTitle,
            project,
            category,
            tags
        );

        var titleChanged = !string.Equals(before.Title, updated.Title, StringComparison.Ordinal);
        if (!titleChanged || before.LinkedMemoryNotes.Count == 0)
        {
            return updated;
        }

        var renamedNotes = before.LinkedMemoryNotes
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name =>
            {
                var original = name.Trim();
                var renamed = _memoryNoteStore.RenameForConversationTitle(original, updated.Title);
                return string.IsNullOrWhiteSpace(renamed) ? original : renamed;
            })
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return _conversationStore.SetLinkedMemoryNotes(updated.Id, renamedNotes);
    }

    public WorkspaceFilePreview? ReadWorkspaceFile(string filePath, int maxChars = 120_000)
    {
        var raw = (filePath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        try
        {
            var root = ResolveWorkspaceRoot();
            var fullPath = Path.GetFullPath(raw);
            if (!IsPathUnderRoot(fullPath, root) || !File.Exists(fullPath))
            {
                return null;
            }

            var content = File.ReadAllText(fullPath);
            if (content.Length > maxChars)
            {
                content = content[..maxChars] + "\n...(truncated)";
            }

            return new WorkspaceFilePreview(fullPath, content);
        }
        catch
        {
            return null;
        }
    }
}
