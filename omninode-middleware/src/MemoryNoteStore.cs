using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed class MemoryNoteStore
{
    private static readonly Regex MultiWhitespaceRegex = new(@"\s+", RegexOptions.Compiled);
    private static readonly HashSet<char> InvalidFileNameCharSet = Path.GetInvalidFileNameChars().ToHashSet();
    private readonly string _rootDir;

    public MemoryNoteStore(string rootDir)
    {
        _rootDir = Path.GetFullPath(rootDir);
        Directory.CreateDirectory(_rootDir);
    }

    public MemoryNoteSaveResult Save(
        string modeKey,
        string conversationId,
        string conversationTitle,
        string provider,
        string model,
        string summary
    )
    {
        var safeMode = Sanitize(modeKey, "mode", 48);
        var safeTitle = Sanitize(conversationTitle, "conversation", 96);
        var fileName = ResolveSaveFileName($"{safeTitle}_{safeMode}", conversationId);
        var fullPath = Path.Combine(_rootDir, fileName);

        var builder = new StringBuilder();
        builder.AppendLine($"# Memory Note");
        builder.AppendLine();
        builder.AppendLine($"- created_utc: {DateTimeOffset.UtcNow:O}");
        builder.AppendLine($"- mode: {modeKey}");
        builder.AppendLine($"- conversation_id: {conversationId}");
        builder.AppendLine($"- conversation_title: {conversationTitle}");
        builder.AppendLine($"- provider: {provider}");
        builder.AppendLine($"- model: {model}");
        builder.AppendLine();
        builder.AppendLine("## Summary");
        builder.AppendLine();
        builder.AppendLine(summary.Trim());

        AtomicFileStore.WriteAllText(fullPath, builder.ToString(), ownerOnly: true);

        var excerpt = BuildExcerpt(summary);
        return new MemoryNoteSaveResult(fileName, fullPath, excerpt);
    }

    public string RenameForConversationTitle(string name, string conversationTitle)
    {
        var safe = Sanitize(name, string.Empty, 240);
        if (string.IsNullOrWhiteSpace(safe))
        {
            return string.Empty;
        }

        var sourcePath = Path.Combine(_rootDir, safe);
        if (!File.Exists(sourcePath))
        {
            return safe;
        }

        var rawMode = TryReadMode(sourcePath);
        var safeMode = Sanitize(rawMode ?? string.Empty, "mode", 48);
        var safeTitle = Sanitize(conversationTitle, "conversation", 96);
        var targetName = ResolveRenameFileName($"{safeTitle}_{safeMode}", sourcePath);
        var targetPath = Path.Combine(_rootDir, targetName);

        try
        {
            if (!PathEquals(sourcePath, targetPath))
            {
                File.Move(sourcePath, targetPath);
            }

            RewriteConversationTitle(targetPath, conversationTitle);
            return targetName;
        }
        catch
        {
            return safe;
        }
    }

    public IReadOnlyList<MemoryNoteItem> List()
    {
        if (!Directory.Exists(_rootDir))
        {
            return Array.Empty<MemoryNoteItem>();
        }

        var result = new List<MemoryNoteItem>();
        foreach (var file in Directory.EnumerateFiles(_rootDir, "*.md", SearchOption.TopDirectoryOnly))
        {
            try
            {
                var info = new FileInfo(file);
                var content = File.ReadAllText(file);
                var excerpt = BuildExcerpt(content);
                result.Add(new MemoryNoteItem(
                    info.Name,
                    info.FullName,
                    excerpt,
                    info.Length,
                    info.LastWriteTimeUtc
                ));
            }
            catch
            {
            }
        }

        return result
            .OrderByDescending(x => x.LastWriteUtc)
            .ToArray();
    }

    public MemoryNoteReadResult? Read(string name)
    {
        var safe = Sanitize(name, string.Empty, 240);
        if (string.IsNullOrWhiteSpace(safe))
        {
            return null;
        }

        var fullPath = Path.Combine(_rootDir, safe);
        if (!File.Exists(fullPath))
        {
            return null;
        }

        var content = File.ReadAllText(fullPath);
        return new MemoryNoteReadResult(safe, fullPath, content);
    }

    public int DeleteByScope(string scope)
    {
        if (!Directory.Exists(_rootDir))
        {
            return 0;
        }

        var normalizedScope = NormalizeScope(scope);
        var removed = 0;
        foreach (var file in Directory.EnumerateFiles(_rootDir, "*.md", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (!ShouldDeleteByScope(file, normalizedScope))
                {
                    continue;
                }

                File.Delete(file);
                removed += 1;
            }
            catch
            {
            }
        }

        return removed;
    }

    public bool Delete(string name)
    {
        var safe = Sanitize(name, string.Empty, 240);
        if (string.IsNullOrWhiteSpace(safe))
        {
            return false;
        }

        var fullPath = Path.Combine(_rootDir, safe);
        if (!File.Exists(fullPath))
        {
            return false;
        }

        try
        {
            File.Delete(fullPath);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string BuildExcerpt(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        var oneLine = content
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        return oneLine.Length <= 240 ? oneLine : oneLine[..240] + "...";
    }

    private string ResolveSaveFileName(string baseName, string conversationId)
    {
        var normalizedConversationId = (conversationId ?? string.Empty).Trim();
        for (var index = 1; index <= 256; index++)
        {
            var suffix = index == 1 ? string.Empty : $"_{index}";
            var candidate = $"{baseName}{suffix}.md";
            var fullPath = Path.Combine(_rootDir, candidate);
            if (!File.Exists(fullPath))
            {
                return candidate;
            }

            var ownerConversationId = TryReadHeaderValue(fullPath, "conversation_id");
            if (!string.IsNullOrWhiteSpace(ownerConversationId)
                && ownerConversationId.Equals(normalizedConversationId, StringComparison.Ordinal))
            {
                return candidate;
            }
        }

        return $"{baseName}_{DateTimeOffset.UtcNow:yyyyMMddHHmmssfff}.md";
    }

    private string ResolveRenameFileName(string baseName, string sourcePath)
    {
        for (var index = 1; index <= 256; index++)
        {
            var suffix = index == 1 ? string.Empty : $"_{index}";
            var candidate = $"{baseName}{suffix}.md";
            var fullPath = Path.Combine(_rootDir, candidate);
            if (PathEquals(fullPath, sourcePath) || !File.Exists(fullPath))
            {
                return candidate;
            }
        }

        return $"{baseName}_{DateTimeOffset.UtcNow:yyyyMMddHHmmssfff}.md";
    }

    private static void RewriteConversationTitle(string fullPath, string conversationTitle)
    {
        try
        {
            var safeTitle = NormalizeFieldValue(conversationTitle, "conversation");
            var lines = File.ReadAllLines(fullPath).ToList();
            if (lines.Count == 0)
            {
                return;
            }

            var updated = false;
            for (var i = 0; i < Math.Min(lines.Count, 64); i++)
            {
                if (lines[i].StartsWith("- conversation_title:", StringComparison.OrdinalIgnoreCase))
                {
                    lines[i] = $"- conversation_title: {safeTitle}";
                    updated = true;
                    break;
                }
            }

            if (!updated)
            {
                var conversationIdIndex = lines.FindIndex(line =>
                    line.StartsWith("- conversation_id:", StringComparison.OrdinalIgnoreCase));
                var insertIndex = conversationIdIndex >= 0 ? conversationIdIndex + 1 : Math.Min(lines.Count, 8);
                lines.Insert(insertIndex, $"- conversation_title: {safeTitle}");
            }

            AtomicFileStore.WriteAllText(fullPath, string.Join('\n', lines), ownerOnly: true);
        }
        catch
        {
        }
    }

    private static string? TryReadHeaderValue(string fullPath, string fieldName)
    {
        var key = $"- {fieldName}:";
        try
        {
            foreach (var line in File.ReadLines(fullPath).Take(64))
            {
                if (line.StartsWith(key, StringComparison.OrdinalIgnoreCase))
                {
                    return line[key.Length..].Trim();
                }
            }
        }
        catch
        {
        }

        return null;
    }

    private static string NormalizeFieldValue(string raw, string fallback)
    {
        var sanitized = (raw ?? string.Empty)
            .Replace('\r', ' ')
            .Replace('\n', ' ');
        sanitized = MultiWhitespaceRegex.Replace(sanitized, " ").Trim();
        if (string.IsNullOrWhiteSpace(sanitized))
        {
            return fallback;
        }

        return sanitized.Length <= 160 ? sanitized : sanitized[..160].TrimEnd();
    }

    private static string Sanitize(string raw, string fallback, int maxLength)
    {
        var normalized = NormalizeFieldValue(Path.GetFileName((raw ?? string.Empty).Replace('\\', '/')), fallback);
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return fallback;
        }

        var builder = new StringBuilder(normalized.Length);
        foreach (var ch in normalized)
        {
            if (char.IsControl(ch) || InvalidFileNameCharSet.Contains(ch))
            {
                builder.Append('_');
            }
            else
            {
                builder.Append(ch);
            }
        }

        var safe = builder.ToString().Trim().Trim('.');
        if (string.IsNullOrWhiteSpace(safe))
        {
            return fallback;
        }

        if (safe.Length > maxLength)
        {
            safe = safe[..maxLength].TrimEnd();
        }

        return safe;
    }

    private static bool PathEquals(string left, string right)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return string.Equals(left, right, comparison);
    }

    private static string NormalizeScope(string? scope)
    {
        var normalized = (scope ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized == "telegram")
        {
            return "chat";
        }

        return normalized switch
        {
            "chat" => "chat",
            "coding" => "coding",
            "all" => "all",
            _ => "chat"
        };
    }

    private static bool ShouldDeleteByScope(string fullPath, string normalizedScope)
    {
        if (normalizedScope == "all")
        {
            return true;
        }

        var mode = TryReadMode(fullPath);
        if (!string.IsNullOrWhiteSpace(mode))
        {
            var normalizedMode = mode.Trim().ToLowerInvariant();
            return normalizedScope switch
            {
                "chat" => normalizedMode.StartsWith("chat-", StringComparison.OrdinalIgnoreCase)
                          || normalizedMode.StartsWith("telegram-", StringComparison.OrdinalIgnoreCase),
                "coding" => normalizedMode.StartsWith("coding-", StringComparison.OrdinalIgnoreCase),
                _ => false
            };
        }

        var fileName = Path.GetFileName(fullPath);
        return normalizedScope switch
        {
            "chat" => fileName.Contains("_chat-", StringComparison.OrdinalIgnoreCase)
                      || fileName.Contains("_telegram-", StringComparison.OrdinalIgnoreCase),
            "coding" => fileName.Contains("_coding-", StringComparison.OrdinalIgnoreCase),
            _ => false
        };
    }

    private static string? TryReadMode(string fullPath)
    {
        try
        {
            var content = File.ReadAllText(fullPath);
            var lines = content
                .Replace("\r\n", "\n", StringComparison.Ordinal)
                .Replace('\r', '\n')
                .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines.Take(32))
            {
                if (line.StartsWith("- mode:", StringComparison.OrdinalIgnoreCase))
                {
                    return line[7..].Trim();
                }
            }
        }
        catch
        {
        }

        return null;
    }
}

public sealed record MemoryNoteItem(
    string Name,
    string FullPath,
    string Excerpt,
    long SizeBytes,
    DateTime LastWriteUtc
);

public sealed record MemoryNoteReadResult(
    string Name,
    string FullPath,
    string Content
);

public sealed record MemoryNoteSaveResult(
    string Name,
    string FullPath,
    string Excerpt
);

public sealed record MemoryNoteCreateResult(
    bool Ok,
    string Message,
    MemoryNoteSaveResult? Note,
    ConversationThreadView? Conversation
);

public sealed record MemoryNoteDeleteResult(
    bool Ok,
    string Message,
    int Requested,
    int Removed,
    int UnlinkedConversations,
    IReadOnlyList<string> RemovedNames
);
