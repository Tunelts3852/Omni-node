namespace OmniNode.Middleware;

public sealed class AnchorEditService
{
    public sealed record AnchorEditComputation(
        bool Ok,
        string OriginalText,
        string UpdatedText,
        IReadOnlyList<AnchorEditRequest> Edits,
        IReadOnlyList<AnchorEditIssue> Issues
    );

    public AnchorEditComputation ComputePreview(
        string path,
        string originalText,
        IReadOnlyList<AnchorEditRequest>? edits
    )
    {
        var requested = (edits ?? Array.Empty<AnchorEditRequest>())
            .Where(edit => edit != null)
            .Select(NormalizeEdit)
            .ToArray();

        var issues = new List<AnchorEditIssue>();
        if (requested.Length == 0)
        {
            issues.Add(new AnchorEditIssue(
                0,
                0,
                "preview를 만들 edit가 없습니다.",
                Array.Empty<string>(),
                Array.Empty<string>(),
                string.Empty
            ));
            return new AnchorEditComputation(false, originalText, originalText, Array.Empty<AnchorEditRequest>(), issues);
        }

        var lines = AnchorReadService.SplitLines(originalText);
        var ordered = requested
            .OrderBy(edit => edit.StartLine)
            .ThenBy(edit => edit.EndLine)
            .ToArray();

        var previousEnd = 0;
        foreach (var edit in ordered)
        {
            if (edit.StartLine < 1 || edit.EndLine < edit.StartLine)
            {
                issues.Add(BuildIssue(
                    edit,
                    "line 범위가 올바르지 않습니다.",
                    Array.Empty<string>(),
                    string.Empty
                ));
                continue;
            }

            if (edit.StartLine <= previousEnd)
            {
                issues.Add(BuildIssue(
                    edit,
                    "겹치는 edit 범위는 지원하지 않습니다.",
                    Array.Empty<string>(),
                    string.Empty
                ));
                continue;
            }

            previousEnd = edit.EndLine;
            var expectedCount = edit.EndLine - edit.StartLine + 1;
            if (edit.ExpectedHashes.Count != expectedCount)
            {
                issues.Add(BuildIssue(
                    edit,
                    "expectedHashes 길이가 선택한 line 범위와 다릅니다.",
                    Array.Empty<string>(),
                    string.Empty
                ));
                continue;
            }

            if (edit.EndLine > lines.Count)
            {
                var snippet = BuildSnippet(lines, edit.StartLine, Math.Min(edit.EndLine, lines.Count));
                issues.Add(BuildIssue(
                    edit,
                    "현재 파일 line 수와 선택 범위가 맞지 않습니다.",
                    Array.Empty<string>(),
                    snippet
                ));
                continue;
            }

            var actualHashes = Enumerable.Range(edit.StartLine, expectedCount)
                .Select(lineNumber => AnchorReadService.BuildLineHash(path, lineNumber, lines[lineNumber - 1]))
                .ToArray();
            var expectedHashes = edit.ExpectedHashes
                .Select(hash => (hash ?? string.Empty).Trim())
                .ToArray();
            if (!actualHashes.SequenceEqual(expectedHashes, StringComparer.Ordinal))
            {
                issues.Add(new AnchorEditIssue(
                    edit.StartLine,
                    edit.EndLine,
                    "anchor mismatch: preview를 만든 뒤 파일이 바뀌었습니다.",
                    expectedHashes,
                    actualHashes,
                    BuildSnippet(lines, edit.StartLine, edit.EndLine)
                ));
            }
        }

        if (issues.Count > 0)
        {
            return new AnchorEditComputation(false, originalText, originalText, ordered, issues);
        }

        var updated = lines.ToList();
        foreach (var edit in ordered.OrderByDescending(item => item.StartLine))
        {
            var startIndex = edit.StartLine - 1;
            var removeCount = edit.EndLine - edit.StartLine + 1;
            updated.RemoveRange(startIndex, removeCount);
            var replacementLines = AnchorReadService.SplitLines(edit.Replacement);
            if (replacementLines.Count > 0)
            {
                updated.InsertRange(startIndex, replacementLines);
            }
        }

        return new AnchorEditComputation(
            true,
            originalText,
            AnchorReadService.JoinLines(updated, PreserveTrailingNewline(originalText)),
            ordered,
            Array.Empty<AnchorEditIssue>()
        );
    }

    private static AnchorEditRequest NormalizeEdit(AnchorEditRequest edit)
    {
        var hashes = (edit.ExpectedHashes ?? Array.Empty<string>())
            .Where(hash => !string.IsNullOrWhiteSpace(hash))
            .Select(hash => hash.Trim())
            .ToArray();
        return new AnchorEditRequest(
            edit.StartLine,
            edit.EndLine,
            hashes,
            AnchorReadService.NormalizeNewlines(edit.Replacement ?? string.Empty)
        );
    }

    private static AnchorEditIssue BuildIssue(
        AnchorEditRequest edit,
        string reason,
        IReadOnlyList<string> actualHashes,
        string snippet
    )
    {
        return new AnchorEditIssue(
            edit.StartLine,
            edit.EndLine,
            reason,
            edit.ExpectedHashes,
            actualHashes,
            snippet
        );
    }

    private static string BuildSnippet(IReadOnlyList<string> lines, int startLine, int endLine)
    {
        if (lines.Count == 0 || startLine > endLine)
        {
            return string.Empty;
        }

        var safeStart = Math.Max(1, startLine);
        var safeEnd = Math.Min(endLine, lines.Count);
        if (safeStart > safeEnd)
        {
            return string.Empty;
        }

        return string.Join(
            "\n",
            Enumerable.Range(safeStart, safeEnd - safeStart + 1)
                .Take(8)
                .Select(lineNumber => lines[lineNumber - 1])
        );
    }

    private static bool PreserveTrailingNewline(string text)
    {
        var normalized = AnchorReadService.NormalizeNewlines(text);
        return normalized.EndsWith('\n');
    }
}
