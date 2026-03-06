namespace OmniNode.Middleware;

public static class SearchEvidencePackBuilder
{
    private const double TrustFloor = 0.55d;

    public static SearchEvidencePack Build(
        SearchRequest request,
        IReadOnlyList<SearchDocument> documents,
        int targetCount,
        int minIndependentSources,
        bool countLockSatisfied,
        string coverageReason,
        SearchLoopTermination? termination = null
    )
    {
        var items = documents
            .Select(MapItem)
            .ToArray();
        var claims = BuildClaims(items);
        var maxAgeHours = ResolveEffectiveMaxAgeHours(request.Constraints.MaxAgeHours);
        var freshnessPass = EvaluateFreshnessPass(
            items,
            request.RequestedAtUtc,
            request.UserTimezone,
            maxAgeHours,
            request.Constraints.StrictTodayWindow
        );
        var credibilityPass = EvaluateCredibilityPass(items);
        var normalizedCoverageReason = NormalizeCoverageReason(
            coverageReason,
            countLockSatisfied,
            targetCount,
            minIndependentSources,
            termination
        );

        return new SearchEvidencePack(
            Query: (request.Query ?? string.Empty).Trim(),
            RequestedAtUtc: request.RequestedAtUtc,
            UserLocale: request.UserLocale,
            UserTimezone: request.UserTimezone,
            IntentProfile: new SearchEvidenceIntentProfile(
                TimeSensitivity: NormalizeEnumValue(request.IntentProfile.TimeSensitivity),
                RiskLevel: NormalizeEnumValue(request.IntentProfile.RiskLevel),
                AnswerType: NormalizeEnumValue(request.IntentProfile.AnswerType)
            ),
            Constraints: new SearchEvidenceConstraints(
                TargetCount: targetCount,
                MinIndependentSources: minIndependentSources,
                MaxAgeHours: request.Constraints.MaxAgeHours,
                StrictTodayWindow: request.Constraints.StrictTodayWindow
            ),
            Items: items,
            Claims: claims,
            Quality: new SearchEvidenceQuality(
                FreshnessPass: freshnessPass,
                CredibilityPass: credibilityPass,
                CoveragePass: countLockSatisfied,
                CoverageReason: normalizedCoverageReason
            )
        );
    }

    private static SearchEvidenceItem MapItem(SearchDocument document)
    {
        return new SearchEvidenceItem(
            CitationId: document.CitationId,
            Title: document.Title,
            Url: document.Url,
            Domain: document.Domain,
            PublishedAt: document.PublishedAt,
            RetrievedAtUtc: document.RetrievedAtUtc,
            Snippet: document.Snippet,
            SourceType: document.SourceType,
            IsPrimarySource: document.IsPrimarySource,
            FreshnessScore: document.FreshnessScore,
            CredibilityScore: document.CredibilityScore,
            DuplicateClusterId: document.DuplicateClusterId
        );
    }

    private static IReadOnlyList<SearchEvidenceClaim> BuildClaims(IReadOnlyList<SearchEvidenceItem> items)
    {
        if (items.Count == 0)
        {
            return Array.Empty<SearchEvidenceClaim>();
        }

        var claims = new SearchEvidenceClaim[items.Count];
        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            var claimText = string.IsNullOrWhiteSpace(item.Snippet) ? item.Title : item.Snippet;
            claims[index] = new SearchEvidenceClaim(
                ClaimId: $"k{index + 1}",
                Text: claimText,
                SupportedBy: new[] { item.CitationId },
                ConflictWith: Array.Empty<string>()
            );
        }

        return claims;
    }

    private static string NormalizeCoverageReason(
        string coverageReason,
        bool countLockSatisfied,
        int targetCount,
        int minIndependentSources,
        SearchLoopTermination? termination
    )
    {
        var reasonCode = ResolveReasonCode(termination?.CountLockReasonCode, coverageReason, countLockSatisfied);
        if (termination is null)
        {
            return reasonCode;
        }

        return
            $"{reasonCode} (termination={termination.ReasonCode}, target={targetCount}, valid={termination.ValidDocumentCount}, independentSources={termination.IndependentSourceCount}, minIndependentSources={minIndependentSources}, attempts={termination.AttemptCount}, candidates={termination.CollectedCandidateCount})";
    }

    private static string ResolveReasonCode(
        string? primaryReasonCode,
        string fallbackReasonCode,
        bool countLockSatisfied
    )
    {
        var primary = (primaryReasonCode ?? string.Empty).Trim();
        if (primary.Length > 0)
        {
            return primary;
        }

        var fallback = (fallbackReasonCode ?? string.Empty).Trim();
        if (fallback.Length > 0)
        {
            return fallback;
        }

        return countLockSatisfied ? "count_lock_satisfied" : "count_lock_unsatisfied";
    }

    private static int ResolveEffectiveMaxAgeHours(int configuredMaxAgeHours)
    {
        return configuredMaxAgeHours > 0 ? configuredMaxAgeHours : 24;
    }

    private static bool EvaluateFreshnessPass(
        IReadOnlyList<SearchEvidenceItem> items,
        DateTimeOffset requestedAtUtc,
        string userTimezone,
        int maxAgeHours,
        bool strictTodayWindow
    )
    {
        if (items.Count == 0)
        {
            return false;
        }

        var timezone = ResolveTimeZone(userTimezone);
        var requestedLocalDate = TimeZoneInfo.ConvertTime(requestedAtUtc, timezone).Date;
        foreach (var item in items)
        {
            if (item.PublishedAt > requestedAtUtc)
            {
                return false;
            }

            var ageHours = (requestedAtUtc - item.PublishedAt).TotalHours;
            if (ageHours < 0 || ageHours > maxAgeHours)
            {
                return false;
            }

            if (!strictTodayWindow)
            {
                continue;
            }

            var publishedLocalDate = TimeZoneInfo.ConvertTime(item.PublishedAt, timezone).Date;
            if (publishedLocalDate != requestedLocalDate)
            {
                return false;
            }
        }

        return true;
    }

    private static bool EvaluateCredibilityPass(IReadOnlyList<SearchEvidenceItem> items)
    {
        if (items.Count == 0)
        {
            return false;
        }

        return items.All(item =>
            item.CredibilityScore >= TrustFloor
            && !string.IsNullOrWhiteSpace(item.Domain)
        );
    }

    private static TimeZoneInfo ResolveTimeZone(string? timezoneId)
    {
        var normalized = (timezoneId ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return TimeZoneInfo.Utc;
        }

        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(normalized);
        }
        catch
        {
            return TimeZoneInfo.Utc;
        }
    }

    private static string NormalizeEnumValue<TEnum>(TEnum value)
        where TEnum : struct, Enum
    {
        return value.ToString().ToLowerInvariant();
    }
}
