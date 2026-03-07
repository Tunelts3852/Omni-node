namespace OmniNode.Middleware;

public sealed record WebSearchResultItem(
    string Title,
    string Url,
    string Description,
    string? Published,
    string CitationId = "-"
);

public sealed record ExternalContentDescriptor(
    bool Untrusted,
    string Source,
    string Provider,
    bool Wrapped
);

public sealed record WebSearchToolResult(
    string Provider,
    IReadOnlyList<WebSearchResultItem> Results,
    bool Disabled,
    string? Error,
    ExternalContentDescriptor? ExternalContent = null,
    SearchAnswerGuardFailure? GuardFailure = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-"
);
