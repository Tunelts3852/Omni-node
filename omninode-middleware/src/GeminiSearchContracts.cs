namespace OmniNode.Middleware;

public enum GeminiKeySource
{
    Keychain,
    SecureFile600
}

public static class GeminiKeyPolicy
{
    public static readonly IReadOnlyList<string> RequiredFor = new[]
    {
        "test",
        "validation",
        "regression",
        "production_run"
    };

    public static bool TryParseSource(string? raw, out GeminiKeySource source)
    {
        var normalized = (raw ?? string.Empty).Trim().ToLowerInvariant();
        switch (normalized)
        {
            case "keychain":
                source = GeminiKeySource.Keychain;
                return true;
            case "secure_file_600":
                source = GeminiKeySource.SecureFile600;
                return true;
            default:
                source = default;
                return false;
        }
    }

    public static string ToPolicyValue(this GeminiKeySource source)
    {
        return source == GeminiKeySource.Keychain ? "keychain" : "secure_file_600";
    }
}

public enum QueryTimeSensitivity
{
    High,
    Medium,
    Low
}

public enum QueryRiskLevel
{
    High,
    Normal
}

public enum QueryAnswerType
{
    Short,
    List,
    Explain,
    Code,
    Compare
}

public enum SearchRetrieverPath
{
    GeminiGrounding
}

public enum SearchLoopTerminationReason
{
    Success,
    EmptyQuery,
    RetrievePlanExhausted
}

public sealed record SearchIntentProfile(
    QueryTimeSensitivity TimeSensitivity,
    QueryRiskLevel RiskLevel,
    QueryAnswerType AnswerType
);

public sealed record SearchConstraints(
    int TargetCount,
    int MinIndependentSources,
    int MaxAgeHours,
    bool StrictTodayWindow
);

public sealed record SearchRequest(
    string Query,
    DateTimeOffset RequestedAtUtc,
    string UserLocale,
    string UserTimezone,
    SearchIntentProfile IntentProfile,
    SearchConstraints Constraints
);

public sealed record SearchDocument(
    string CitationId,
    string Title,
    string Url,
    string Domain,
    DateTimeOffset PublishedAt,
    DateTimeOffset RetrievedAtUtc,
    string Snippet,
    string SourceType,
    bool IsPrimarySource,
    double FreshnessScore,
    double CredibilityScore,
    string DuplicateClusterId
);

public sealed record SearchResponse(
    SearchRetrieverPath RetrieverPath,
    IReadOnlyList<SearchDocument> Documents,
    int TargetCount,
    bool CountLockSatisfied
)
{
    public SearchLoopTermination? Termination { get; init; }
    public SearchEvidencePack? EvidencePack { get; init; }
}

public sealed record SearchLoopTermination(
    SearchLoopTerminationReason Reason,
    string ReasonCode,
    string CountLockReasonCode,
    int AttemptCount,
    int CollectedCandidateCount,
    int ValidDocumentCount,
    int IndependentSourceCount
);

public interface SearchGateway
{
    Task<SearchResponse> SearchAsync(SearchRequest request, CancellationToken cancellationToken = default);
}

public sealed record SearchEvidencePack(
    string Query,
    DateTimeOffset RequestedAtUtc,
    string UserLocale,
    string UserTimezone,
    SearchEvidenceIntentProfile IntentProfile,
    SearchEvidenceConstraints Constraints,
    IReadOnlyList<SearchEvidenceItem> Items,
    IReadOnlyList<SearchEvidenceClaim> Claims,
    SearchEvidenceQuality Quality
);

public sealed record SearchEvidenceIntentProfile(
    string TimeSensitivity,
    string RiskLevel,
    string AnswerType
);

public sealed record SearchEvidenceConstraints(
    int TargetCount,
    int MinIndependentSources,
    int MaxAgeHours,
    bool StrictTodayWindow
);

public sealed record SearchEvidenceItem(
    string CitationId,
    string Title,
    string Url,
    string Domain,
    DateTimeOffset PublishedAt,
    DateTimeOffset RetrievedAtUtc,
    string Snippet,
    string SourceType,
    bool IsPrimarySource,
    double FreshnessScore,
    double CredibilityScore,
    string DuplicateClusterId
);

public sealed record SearchEvidenceClaim(
    string ClaimId,
    string Text,
    IReadOnlyList<string> SupportedBy,
    IReadOnlyList<string> ConflictWith
);

public sealed record SearchEvidenceQuality(
    bool FreshnessPass,
    bool CredibilityPass,
    bool CoveragePass,
    string CoverageReason
);
