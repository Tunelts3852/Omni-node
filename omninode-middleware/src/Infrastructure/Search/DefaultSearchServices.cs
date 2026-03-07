namespace OmniNode.Middleware;

public sealed class DefaultSearchEvidencePackBuilder : IEvidencePackBuilder
{
    public SearchEvidencePack Build(
        SearchRequest request,
        IReadOnlyList<SearchDocument> documents,
        int targetCount,
        int minIndependentSources,
        bool countLockSatisfied,
        string coverageReason,
        SearchLoopTermination? termination = null
    )
    {
        return SearchEvidencePackBuilder.Build(
            request,
            documents,
            targetCount,
            minIndependentSources,
            countLockSatisfied,
            coverageReason,
            termination
        );
    }
}

public sealed class DefaultSearchGuard : ISearchGuard
{
    public SearchAnswerGuardDecision Evaluate(SearchResponse response)
    {
        return SearchAnswerGuard.Evaluate(response);
    }
}
