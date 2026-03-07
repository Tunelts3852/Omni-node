namespace OmniNode.Middleware;

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
