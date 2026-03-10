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
        => ReadWorkspaceFile(filePath, null, maxChars);

    public WorkspaceFilePreview? ReadWorkspaceFile(string filePath, string? conversationId, int maxChars = 120_000)
    {
        var raw = (filePath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        try
        {
            var fullPath = TryResolveWorkspacePreviewPath(raw, conversationId);
            if (string.IsNullOrWhiteSpace(fullPath) || !File.Exists(fullPath))
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

    private string? TryResolveWorkspacePreviewPath(string rawPath, string? conversationId)
    {
        var workspaceRoot = ResolveWorkspaceRoot();
        var normalizedRawPath = (rawPath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedRawPath))
        {
            return null;
        }

        if (TryResolveDirectWorkspacePreviewPath(workspaceRoot, normalizedRawPath, out var directPath))
        {
            return directPath;
        }

        var normalizedConversationId = (conversationId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedConversationId))
        {
            return null;
        }

        var conversation = _conversationStore.Get(normalizedConversationId);
        var latest = conversation?.LatestCodingResult;
        if (latest == null)
        {
            return null;
        }

        return TryResolveConversationPreviewPath(normalizedRawPath, latest, workspaceRoot);
    }

    private static bool TryResolveDirectWorkspacePreviewPath(string workspaceRoot, string rawPath, out string resolvedPath)
    {
        resolvedPath = string.Empty;
        try
        {
            var candidate = Path.IsPathRooted(rawPath)
                ? Path.GetFullPath(rawPath)
                : Path.GetFullPath(Path.Combine(workspaceRoot, rawPath));
            if (!IsPathUnderRoot(candidate, workspaceRoot) || !File.Exists(candidate))
            {
                return false;
            }

            resolvedPath = candidate;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string? TryResolveConversationPreviewPath(
        string rawPath,
        ConversationCodingResultSnapshot latest,
        string workspaceRoot
    )
    {
        var previewRoots = BuildConversationPreviewRoots(latest, workspaceRoot);
        var previewFiles = BuildConversationPreviewFiles(latest)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (Path.IsPathRooted(rawPath))
        {
            try
            {
                var fullRequested = Path.GetFullPath(rawPath);
                if (File.Exists(fullRequested)
                    && previewRoots.Any(root => IsPathUnderRoot(fullRequested, root)))
                {
                    return fullRequested;
                }
            }
            catch
            {
            }
        }

        var normalizedRequested = NormalizePreviewPath(rawPath);
        if (!string.IsNullOrWhiteSpace(normalizedRequested))
        {
            var suffixMatches = previewFiles
                .Where(File.Exists)
                .Where(path => PathMatchesPreviewRequest(path, normalizedRequested))
                .ToArray();
            if (suffixMatches.Length == 1)
            {
                return suffixMatches[0];
            }

            if (suffixMatches.Length > 1)
            {
                var exactRunDirMatch = suffixMatches.FirstOrDefault(path =>
                    string.Equals(
                        NormalizePreviewPath(path),
                        normalizedRequested,
                        StringComparison.OrdinalIgnoreCase
                    ));
                if (!string.IsNullOrWhiteSpace(exactRunDirMatch))
                {
                    return exactRunDirMatch;
                }
            }
        }

        if (!Path.IsPathRooted(rawPath))
        {
            foreach (var root in previewRoots)
            {
                try
                {
                    var candidate = Path.GetFullPath(Path.Combine(root, rawPath));
                    if (File.Exists(candidate) && IsPathUnderRoot(candidate, root))
                    {
                        return candidate;
                    }
                }
                catch
                {
                }
            }
        }

        var basename = Path.GetFileName(rawPath.Trim());
        if (!string.IsNullOrWhiteSpace(basename))
        {
            var basenameMatches = previewFiles
                .Where(File.Exists)
                .Where(path => string.Equals(Path.GetFileName(path), basename, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (basenameMatches.Length == 1)
            {
                return basenameMatches[0];
            }
        }

        return null;
    }

    private static string[] BuildConversationPreviewRoots(
        ConversationCodingResultSnapshot latest,
        string workspaceRoot
    )
    {
        return EnumerateConversationPreviewRoots(latest, workspaceRoot)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => Path.GetFullPath(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IEnumerable<string> EnumerateConversationPreviewRoots(
        ConversationCodingResultSnapshot latest,
        string workspaceRoot
    )
    {
        yield return workspaceRoot;

        var latestRunDirectory = (latest.Execution.RunDirectory ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(latestRunDirectory))
        {
            yield return latestRunDirectory;
        }

        foreach (var worker in latest.Workers ?? Array.Empty<CodingWorkerResultSnapshot>())
        {
            var workerRunDirectory = (worker.Execution.RunDirectory ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(workerRunDirectory))
            {
                yield return workerRunDirectory;
            }
        }
    }

    private static string[] BuildConversationPreviewFiles(ConversationCodingResultSnapshot latest)
    {
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        AddConversationPreviewFileCandidates(files, latest.Execution, latest.ChangedFiles);
        foreach (var worker in latest.Workers ?? Array.Empty<CodingWorkerResultSnapshot>())
        {
            AddConversationPreviewFileCandidates(files, worker.Execution, worker.ChangedFiles);
        }

        return files.ToArray();
    }

    private static void AddConversationPreviewFileCandidates(
        ISet<string> files,
        CodeExecutionResult execution,
        IReadOnlyList<string> changedFiles
    )
    {
        foreach (var path in changedFiles ?? Array.Empty<string>())
        {
            if (TryNormalizeFullPreviewCandidate(path, out var fullPath))
            {
                files.Add(fullPath);
            }
        }

        var runDirectory = (execution.RunDirectory ?? string.Empty).Trim();
        var entryFile = (execution.EntryFile ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runDirectory) || string.IsNullOrWhiteSpace(entryFile))
        {
            return;
        }

        try
        {
            var fullPath = Path.IsPathRooted(entryFile)
                ? Path.GetFullPath(entryFile)
                : Path.GetFullPath(Path.Combine(runDirectory, entryFile));
            files.Add(fullPath);
        }
        catch
        {
        }
    }

    private static bool TryNormalizeFullPreviewCandidate(string path, out string fullPath)
    {
        fullPath = string.Empty;
        var normalized = (path ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return false;
        }

        try
        {
            fullPath = Path.GetFullPath(normalized);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool PathMatchesPreviewRequest(string candidatePath, string normalizedRequested)
    {
        var normalizedCandidate = NormalizePreviewPath(candidatePath);
        if (string.Equals(normalizedCandidate, normalizedRequested, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return normalizedCandidate.EndsWith("/" + normalizedRequested, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizePreviewPath(string value)
    {
        return (value ?? string.Empty)
            .Trim()
            .Replace('\\', '/')
            .Trim('/');
    }
}
