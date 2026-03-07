namespace OmniNode.Middleware;

public sealed record SearchAnswerCompositionRequest(
    string Input,
    string MemoryHint,
    bool SelfDecideNeedWeb,
    bool AllowMarkdownTable,
    bool EnforceTelegramOutputStyle,
    string Scope,
    string Mode,
    string ConversationId,
    string DecisionPath,
    long DecisionMs,
    Action<ChatStreamUpdate>? StreamCallback = null
);

public sealed record SearchAnswerCompositionResult(
    LlmSingleChatResult Response,
    string Route,
    ChatLatencyMetrics? Latency = null,
    IReadOnlyList<SearchCitationReference>? Citations = null,
    SearchAnswerGuardFailure? GuardFailure = null,
    SearchRetrieverPath? RetrieverPath = null
);

public interface ISearchRetriever
{
    Task<GeminiGroundedRetrieverResult> RetrieveAsync(
        SearchRequest request,
        int maxResults,
        CancellationToken cancellationToken = default
    );
}

public interface IEvidencePackBuilder
{
    SearchEvidencePack Build(
        SearchRequest request,
        IReadOnlyList<SearchDocument> documents,
        int targetCount,
        int minIndependentSources,
        bool countLockSatisfied,
        string coverageReason,
        SearchLoopTermination? termination = null
    );
}

public interface ISearchGuard
{
    SearchAnswerGuardDecision Evaluate(SearchResponse response);
}

public interface ISearchAnswerComposer
{
    Task<SearchAnswerCompositionResult> ComposeGroundedWebAnswerAsync(
        SearchAnswerCompositionRequest request,
        CancellationToken cancellationToken = default
    );
}
