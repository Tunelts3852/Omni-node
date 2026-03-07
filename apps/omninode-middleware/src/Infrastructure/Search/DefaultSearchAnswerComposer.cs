using System.Globalization;
using System.Text;

namespace OmniNode.Middleware;

public sealed class EvidenceFallbackSearchAnswerComposer : ISearchAnswerComposer
{
    private readonly SearchGateway _searchGateway;
    private readonly ISearchGuard _searchGuard;

    public EvidenceFallbackSearchAnswerComposer(SearchGateway searchGateway, ISearchGuard searchGuard)
    {
        _searchGateway = searchGateway;
        _searchGuard = searchGuard;
    }

    public async Task<SearchAnswerCompositionResult> ComposeGroundedWebAnswerAsync(
        SearchAnswerCompositionRequest request,
        CancellationToken cancellationToken = default
    )
    {
        var normalizedInput = (request.Input ?? string.Empty).Trim();
        var searchRequest = BuildSearchRequest(normalizedInput);
        var response = await _searchGateway.SearchAsync(searchRequest, cancellationToken).ConfigureAwait(false);
        var guardDecision = _searchGuard.Evaluate(response);
        var route = response.RetrieverPath == SearchRetrieverPath.LocalCacheFallback
            ? "search-cache-fallback"
            : "search-evidence-fallback";
        var citations = BuildCitations(response.Documents);
        var canReturnPartial = response.Documents.Count > 0
            && (guardDecision.Allowed || guardDecision.Failure?.Category == SearchAnswerGuardFailureCategory.Coverage);
        var text = canReturnPartial
            ? BuildEvidenceAnswer(
                normalizedInput,
                response.Documents,
                response.RetrieverPath,
                !guardDecision.Allowed,
                request.EnforceTelegramOutputStyle
            )
            : BuildFailureNotice(guardDecision.Failure, response.Termination);

        if (request.StreamCallback != null && text.Length > 0)
        {
            request.StreamCallback(new ChatStreamUpdate(
                request.Scope,
                request.Mode,
                request.ConversationId,
                "search_evidence",
                response.RetrieverPath == SearchRetrieverPath.LocalCacheFallback ? "local_cache" : "evidence",
                route,
                text,
                1
            ));
        }

        ChatLatencyMetrics? latency = null;
        if (!string.IsNullOrWhiteSpace(request.DecisionPath))
        {
            latency = new ChatLatencyMetrics(
                request.DecisionMs,
                0,
                0,
                0,
                0,
                $"{request.DecisionPath}:search_evidence_fallback"
            );
        }

        return new SearchAnswerCompositionResult(
            new LlmSingleChatResult(
                "search_evidence",
                response.RetrieverPath == SearchRetrieverPath.LocalCacheFallback ? "local_cache" : "evidence",
                text
            ),
            route,
            latency,
            citations,
            canReturnPartial ? null : guardDecision.Failure,
            response.RetrieverPath
        );
    }

    private static SearchRequest BuildSearchRequest(string query)
    {
        var strictTodayWindow = IsTodayWindowQuery(query);
        var answerType = LooksLikeComparisonQuery(query)
            ? QueryAnswerType.Compare
            : LooksLikeListQuery(query)
                ? QueryAnswerType.List
                : QueryAnswerType.Explain;
        return new SearchRequest(
            Query: query,
            RequestedAtUtc: DateTimeOffset.UtcNow,
            UserLocale: ResolveLocalLocale(),
            UserTimezone: ResolveLocalTimezoneId(),
            IntentProfile: new SearchIntentProfile(
                TimeSensitivity: strictTodayWindow || LooksLikeRealtimeQuery(query) ? QueryTimeSensitivity.High : QueryTimeSensitivity.Medium,
                RiskLevel: QueryRiskLevel.Normal,
                AnswerType: answerType
            ),
            Constraints: new SearchConstraints(
                TargetCount: LooksLikeListQuery(query) || LooksLikeComparisonQuery(query) ? 5 : 3,
                MinIndependentSources: 1,
                MaxAgeHours: strictTodayWindow ? 24 : (LooksLikeRealtimeQuery(query) ? 24 : 24 * 7),
                StrictTodayWindow: strictTodayWindow
            )
        );
    }

    private static IReadOnlyList<SearchCitationReference> BuildCitations(IReadOnlyList<SearchDocument> documents)
    {
        if (documents == null || documents.Count == 0)
        {
            return Array.Empty<SearchCitationReference>();
        }

        return documents
            .Select((item, index) => new SearchCitationReference(
                string.IsNullOrWhiteSpace(item.CitationId) ? $"c{index + 1}" : item.CitationId,
                item.Title,
                item.Url,
                item.PublishedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                item.Snippet,
                item.SourceType
            ))
            .ToArray();
    }

    private static string BuildEvidenceAnswer(
        string query,
        IReadOnlyList<SearchDocument> documents,
        SearchRetrieverPath retrieverPath,
        bool partial,
        bool enforceTelegramOutputStyle
    )
    {
        var selected = documents
            .Where(item => item != null)
            .Take(LooksLikeListQuery(query) || LooksLikeComparisonQuery(query) ? 5 : 3)
            .ToArray();
        if (selected.Length == 0)
        {
            return "검색 실패: 확인 가능한 근거를 확보하지 못했습니다.";
        }

        var builder = new StringBuilder();
        if (retrieverPath == SearchRetrieverPath.LocalCacheFallback)
        {
            builder.AppendLine("실시간 검색 대신 최근 확보한 검증 스냅샷 기준으로 정리합니다.");
        }
        else if (partial)
        {
            builder.AppendLine("검색 근거가 일부만 확보되어 확인된 내용만 정리합니다.");
        }
        else
        {
            builder.AppendLine("확인된 검색 근거 기준 요약입니다.");
        }

        for (var index = 0; index < selected.Length; index += 1)
        {
            var doc = selected[index];
            var citationId = string.IsNullOrWhiteSpace(doc.CitationId) ? $"c{index + 1}" : doc.CitationId.Trim();
            var snippet = string.IsNullOrWhiteSpace(doc.Snippet)
                ? "원문 요약이 비어 있어 제목과 출처만 확인했습니다."
                : NormalizeInlineWhitespace(doc.Snippet);
            builder.AppendLine();
            builder.Append(index + 1).Append(". ").Append(doc.Title).Append(" [").Append(citationId).AppendLine("]");
            builder.Append("- 요약: ").Append(snippet).Append(" [").Append(citationId).AppendLine("]");
            builder.Append("- 출처: ").Append(doc.Domain).Append(" · ").Append(doc.PublishedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).AppendLine();
            builder.Append("- 링크: ").AppendLine(doc.Url);
        }

        var text = builder.ToString().Trim();
        if (enforceTelegramOutputStyle && text.Length > 3400)
        {
            return text[..3400].TrimEnd() + "\n\n(이하 생략)";
        }

        return text;
    }

    private static string BuildFailureNotice(SearchAnswerGuardFailure? failure, SearchLoopTermination? termination)
    {
        var reasonCode = (failure?.ReasonCode ?? termination?.ReasonCode ?? "no_documents").Trim().ToLowerInvariant();
        return reasonCode switch
        {
            "gemini_api_key_missing" => "검색 실패: 검색용 Gemini API 키가 없어 대체 경로도 실행하지 못했습니다.",
            "gemini_grounding_timeout" => "검색 실패: 검색 요청이 시간 초과되어 대체 경로에서도 근거를 확보하지 못했습니다.",
            "freshness_guard_failed" => "검색 실패: 최신성 검증을 통과한 근거를 확보하지 못했습니다.",
            "credibility_guard_failed" => "검색 실패: 신뢰도 검증을 통과한 근거를 확보하지 못했습니다.",
            "count_lock_unsatisfied" or "count_lock_unsatisfied_after_retries" => "검색 실패: 필요한 수의 독립 출처를 확보하지 못했습니다.",
            _ => "검색 실패: 검증 가능한 최신 근거를 확보하지 못했습니다."
        };
    }

    private static string NormalizeInlineWhitespace(string value)
    {
        return string.Join(" ", (value ?? string.Empty)
            .Split(new[] { ' ', '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            .Trim();
    }

    private static bool LooksLikeListQuery(string query)
    {
        var lowered = (query ?? string.Empty).Trim().ToLowerInvariant();
        return lowered.Contains("목록", StringComparison.Ordinal)
            || lowered.Contains("리스트", StringComparison.Ordinal)
            || lowered.Contains("추천", StringComparison.Ordinal)
            || lowered.Contains("top", StringComparison.Ordinal)
            || lowered.Contains("best", StringComparison.Ordinal)
            || lowered.Contains("정리", StringComparison.Ordinal);
    }

    private static bool LooksLikeComparisonQuery(string query)
    {
        var lowered = (query ?? string.Empty).Trim().ToLowerInvariant();
        return lowered.Contains("비교", StringComparison.Ordinal)
            || lowered.Contains("차이", StringComparison.Ordinal)
            || lowered.Contains("장단점", StringComparison.Ordinal)
            || lowered.Contains("vs", StringComparison.Ordinal)
            || lowered.Contains("compare", StringComparison.Ordinal);
    }

    private static bool LooksLikeRealtimeQuery(string query)
    {
        var lowered = (query ?? string.Empty).Trim().ToLowerInvariant();
        return lowered.Contains("최신", StringComparison.Ordinal)
            || lowered.Contains("실시간", StringComparison.Ordinal)
            || lowered.Contains("최근", StringComparison.Ordinal)
            || lowered.Contains("today", StringComparison.Ordinal)
            || lowered.Contains("latest", StringComparison.Ordinal)
            || lowered.Contains("recent", StringComparison.Ordinal)
            || lowered.Contains("breaking", StringComparison.Ordinal);
    }

    private static bool IsTodayWindowQuery(string query)
    {
        var lowered = (query ?? string.Empty).Trim().ToLowerInvariant();
        return lowered.Contains("오늘", StringComparison.Ordinal)
            || lowered.Contains("today", StringComparison.Ordinal);
    }

    private static string ResolveLocalLocale()
    {
        var culture = CultureInfo.CurrentCulture;
        return !string.IsNullOrWhiteSpace(culture.Name) ? culture.Name : "ko-KR";
    }

    private static string ResolveLocalTimezoneId()
    {
        try
        {
            return TimeZoneInfo.Local.Id;
        }
        catch
        {
            return "UTC";
        }
    }
}
