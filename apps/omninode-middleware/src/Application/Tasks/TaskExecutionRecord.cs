namespace OmniNode.Middleware;

public sealed record TaskExecutionRecord(
    string GraphId,
    string TaskId,
    string Title,
    string Category,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string Status,
    string ExecutorKind,
    string Source,
    string RuntimePath,
    string StdOutPath,
    string StdErrPath,
    string ResultPath,
    string? ConversationId,
    string? OutputSummary,
    string? ArtifactPath,
    string? Error
);
