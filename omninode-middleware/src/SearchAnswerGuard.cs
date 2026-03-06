using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public enum SearchAnswerGuardFailureCategory
{
    Coverage,
    Freshness,
    Credibility
}

public sealed record SearchAnswerGuardFailure(
    SearchAnswerGuardFailureCategory Category,
    string ReasonCode,
    string Detail
);

public sealed record SearchAnswerGuardDecision(
    bool Allowed,
    SearchAnswerGuardFailure? Failure
);

public static class SearchAnswerGuard
{
    public static SearchAnswerGuardDecision Evaluate(SearchResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);

        if (response.RetrieverPath != SearchRetrieverPath.GeminiGrounding)
        {
            return Block(
                SearchAnswerGuardFailureCategory.Coverage,
                "retriever_path_mismatch",
                $"retrieverPath={response.RetrieverPath}"
            );
        }

        var evidencePack = response.EvidencePack;
        if (evidencePack is null)
        {
            return Block(
                SearchAnswerGuardFailureCategory.Coverage,
                "evidence_pack_missing",
                "SearchResponse.EvidencePack is required for fail-closed guard."
            );
        }

        var quality = evidencePack.Quality;
        var coveragePass = response.CountLockSatisfied && response.Documents.Count > 0;
        if (!coveragePass)
        {
            var reasonCode = ResolveCoverageReasonCode(response, quality.CoverageReason);
            return Block(
                SearchAnswerGuardFailureCategory.Coverage,
                reasonCode,
                $"target={response.TargetCount}, collected={response.Documents.Count}, termination={response.Termination?.ReasonCode ?? "unspecified"}"
            );
        }

        if (!quality.FreshnessPass)
        {
            return Block(
                SearchAnswerGuardFailureCategory.Freshness,
                "freshness_guard_failed",
                $"query={evidencePack.Query}"
            );
        }

        if (!quality.CredibilityPass)
        {
            return Block(
                SearchAnswerGuardFailureCategory.Credibility,
                "credibility_guard_failed",
                $"query={evidencePack.Query}"
            );
        }

        return new SearchAnswerGuardDecision(
            Allowed: true,
            Failure: null
        );
    }

    private static SearchAnswerGuardDecision Block(
        SearchAnswerGuardFailureCategory category,
        string reasonCode,
        string detail
    )
    {
        return new SearchAnswerGuardDecision(
            Allowed: false,
            Failure: new SearchAnswerGuardFailure(
                Category: category,
                ReasonCode: reasonCode,
                Detail: detail
            )
        );
    }

    private static string ResolveCoverageReasonCode(SearchResponse response, string fallbackCoverageReason)
    {
        var countLockReason = (response.Termination?.CountLockReasonCode ?? string.Empty).Trim();
        if (countLockReason.Length > 0 && !string.Equals(countLockReason, "not_evaluated", StringComparison.OrdinalIgnoreCase))
        {
            return countLockReason;
        }

        var coverageReason = (fallbackCoverageReason ?? string.Empty).Trim();
        if (coverageReason.Length > 0 && Regex.IsMatch(coverageReason, @"^[a-z0-9_\-]+$", RegexOptions.CultureInvariant))
        {
            return coverageReason;
        }

        if (response.Documents.Count == 0)
        {
            return "no_documents";
        }

        return "coverage_guard_failed";
    }
}
