namespace OmniNode.Middleware;

public sealed record AnchorLine(int LineNumber, string Hash, string Content);

public sealed record AnchorReadResult(
    string Path,
    IReadOnlyList<AnchorLine> Lines,
    int TotalLines,
    bool Truncated,
    string GeneratedAtUtc
);

public sealed record AnchorEditRequest(
    int StartLine,
    int EndLine,
    IReadOnlyList<string> ExpectedHashes,
    string Replacement
);

public sealed record AnchorEditIssue(
    int StartLine,
    int EndLine,
    string Reason,
    IReadOnlyList<string> ExpectedHashes,
    IReadOnlyList<string> ActualHashes,
    string CurrentSnippet
);

public sealed record RefactorPreviewFile(
    string Path,
    string OriginalText,
    string UpdatedText,
    string OriginalHash,
    string UpdatedHash
);

public sealed record RefactorPreview(
    string PreviewId,
    string Path,
    string UnifiedDiff,
    bool SafeToApply,
    string CreatedAtUtc,
    IReadOnlyList<AnchorEditRequest> Edits,
    IReadOnlyList<AnchorEditIssue> Issues,
    IReadOnlyList<string>? ChangedPaths = null
);

public sealed record RefactorApplyOutcome(
    string PreviewId,
    string Path,
    bool Applied,
    string AppliedAtUtc,
    IReadOnlyList<AnchorEditIssue> Issues,
    IReadOnlyList<string>? ChangedPaths = null
);

public sealed record RefactorToolInvocationResult(
    string Tool,
    bool Enabled,
    bool Available,
    string Status,
    string Message,
    string? BinaryPath = null,
    string? Language = null,
    RefactorPreview? Preview = null
);

public sealed record RefactorActionResult(
    bool Ok,
    string Message,
    AnchorReadResult? ReadResult = null,
    RefactorPreview? Preview = null,
    RefactorApplyOutcome? ApplyResult = null,
    RefactorToolInvocationResult? ToolResult = null,
    IReadOnlyList<AnchorEditIssue>? Issues = null
);

public sealed record RefactorPreviewRecord(
    string PreviewId,
    string Path,
    string OriginalText,
    string UpdatedText,
    string UnifiedDiff,
    string CreatedAtUtc,
    IReadOnlyList<AnchorEditRequest> Edits,
    IReadOnlyList<RefactorPreviewFile>? Files = null
);
