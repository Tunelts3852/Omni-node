using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private sealed record SearchRequirementDecision(
        bool Required,
        string DecisionLabel,
        string SourceFocus,
        string SourceDomain
    );

    private sealed record WebNeedDecisionResult(
        bool NeedWeb,
        bool DecisionSucceeded,
        string Reason,
        string Provider,
        string Model
    );
    private readonly record struct WebPreferenceHint(string Category, string Text);
    private readonly record struct GeminiGroundedWebAnswerResult(
        LlmSingleChatResult Response,
        ChatLatencyMetrics? Latency,
        IReadOnlyList<SearchCitationReference>? Citations = null
    );

    private async Task<WebNeedDecisionResult> DecideNeedWebBySelectedProviderAsync(
        string input,
        string provider,
        string model,
        CancellationToken cancellationToken
    )
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var normalizedProvider = NormalizeProvider(provider, allowAuto: false);
        var resolvedModel = ResolveModel(normalizedProvider, model);
        if (normalizedInput.Length == 0)
        {
            return new WebNeedDecisionResult(false, true, "empty_input", normalizedProvider, resolvedModel);
        }

        var prompt = BuildWebNeedDecisionPrompt(normalizedInput);
        using var decisionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        decisionCts.CancelAfter(TimeSpan.FromMilliseconds(_config.WebDecisionTimeoutMs));
        LlmSingleChatResult decision;
        try
        {
            decision = await GenerateByProviderAsync(
                normalizedProvider,
                resolvedModel,
                prompt,
                decisionCts.Token,
                maxOutputTokens: 96
            );
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new WebNeedDecisionResult(false, false, "decision_timeout", normalizedProvider, resolvedModel);
        }
        catch (Exception ex)
        {
            return new WebNeedDecisionResult(false, false, $"decision_error:{ex.Message}", normalizedProvider, resolvedModel);
        }

        if (TryParseNeedWebDecisionJson(decision.Text, out var needWeb, out var reason))
        {
            return new WebNeedDecisionResult(
                needWeb,
                true,
                reason.Length == 0 ? "json" : $"json:{reason}",
                decision.Provider,
                decision.Model
            );
        }

        var normalizedDecisionToken = NormalizeWebSearchDecisionToken(decision.Text);
        if (normalizedDecisionToken == "yes")
        {
            return new WebNeedDecisionResult(true, true, "token_yes", decision.Provider, decision.Model);
        }

        if (normalizedDecisionToken == "no")
        {
            return new WebNeedDecisionResult(false, true, "token_no", decision.Provider, decision.Model);
        }

        return new WebNeedDecisionResult(false, false, "decision_unparsed", decision.Provider, decision.Model);
    }

    private string BuildWebNeedDecisionPrompt(string normalizedInput)
    {
        return "너는 라우팅 전용 판단기다.\n"
            + "사용자 입력이 최신 외부 웹 근거가 필요한지 판정하고 JSON 한 줄만 출력해라.\n\n"
            + "출력 스키마:\n"
            + "{\"need_web\":true|false,\"reason\":\"짧은 근거\"}\n\n"
            + "판정 규칙:\n"
            + "- 뉴스/오늘/최근/실시간/최신/현재 상태/시세/가격/일정/법·정책 변경/특정 매체 기사 요청이면 need_web=true\n"
            + "- 일반 개념 설명/번역/코드 설명/창작/사용자 제공 텍스트 요약이면 need_web=false\n"
            + "- 설명문, 코드블록, 마크다운 금지\n\n"
            + "사용자 입력:\n"
            + normalizedInput;
    }

    private async Task<GeminiGroundedWebAnswerResult> GenerateGeminiUrlContextAnswerDetailedAsync(
        string input,
        IReadOnlyList<string> urls,
        string memoryHint,
        bool allowMarkdownTable,
        bool enforceTelegramOutputStyle,
        Action<ChatStreamUpdate>? streamCallback,
        string scope,
        string mode,
        string conversationId,
        string decisionPath,
        long decisionMs,
        CancellationToken cancellationToken
    )
    {
        var model = ResolveUrlContextLlmModel();
        const bool includeGoogleSearch = false;
        const string route = "gemini-url-single";
        var chunkIndex = 0;
        Action<string>? deltaCallback = null;
        if (streamCallback != null)
        {
            deltaCallback = delta =>
            {
                if (string.IsNullOrEmpty(delta))
                {
                    return;
                }

                chunkIndex += 1;
                streamCallback(new ChatStreamUpdate(scope, mode, conversationId, "gemini", model, route, delta, chunkIndex));
            };
        }

        var promptStopwatch = Stopwatch.StartNew();
        var prompt = BuildGeminiUrlContextAnswerPrompt(
            input,
            urls,
            memoryHint,
            allowMarkdownTable,
            enforceTelegramOutputStyle,
            includeGoogleSearch
        );
        var maxOutputTokens = ResolveGeminiUrlContextMaxOutputTokens(input);
        var promptBuildMs = Math.Max(0L, promptStopwatch.ElapsedMilliseconds);
        var response = await _llmRouter.GenerateGeminiUrlContextChatStreamingAsync(
            prompt,
            model,
            maxOutputTokens,
            _config.GeminiWebTimeoutMs,
            includeGoogleSearch,
            deltaCallback,
            cancellationToken
        );

        var sanitizeStopwatch = Stopwatch.StartNew();
        string outputText;
        if (IsGeminiUrlContextFailureText(response.Text))
        {
            outputText = BuildGeminiUrlContextFailureNotice(input, response.Text);
        }
        else
        {
            outputText = SanitizeChatOutput(response.Text, keepMarkdownTables: allowMarkdownTable);
            outputText = EnsureReadableWebAnswerResponse(outputText, input, allowMarkdownTable);
        }

        var sanitizeMs = Math.Max(0L, sanitizeStopwatch.ElapsedMilliseconds);
        ChatLatencyMetrics? latency = null;
        if (!string.IsNullOrWhiteSpace(decisionPath))
        {
            latency = new ChatLatencyMetrics(
                decisionMs,
                promptBuildMs,
                response.FirstChunkMs,
                response.FullResponseMs,
                sanitizeMs,
                decisionPath
            );
        }

        return new GeminiGroundedWebAnswerResult(
            new LlmSingleChatResult("gemini", model, outputText),
            latency,
            response.Citations
        );
    }

    private async Task<LlmSingleChatResult> GenerateGeminiGroundedWebAnswerAsync(
        string input,
        string memoryHint,
        bool selfDecideNeedWeb,
        bool allowMarkdownTable,
        bool enforceTelegramOutputStyle,
        CancellationToken cancellationToken
    )
    {
        var result = await GenerateGeminiGroundedWebAnswerDetailedAsync(
            input,
            memoryHint,
            selfDecideNeedWeb,
            allowMarkdownTable,
            enforceTelegramOutputStyle,
            null,
            "chat",
            "single",
            string.Empty,
            string.Empty,
            0,
            cancellationToken
        );
        return result.Response;
    }

    private async Task<GeminiGroundedWebAnswerResult> GenerateGeminiGroundedWebAnswerDetailedAsync(
        string input,
        string memoryHint,
        bool selfDecideNeedWeb,
        bool allowMarkdownTable,
        bool enforceTelegramOutputStyle,
        Action<ChatStreamUpdate>? streamCallback,
        string scope,
        string mode,
        string conversationId,
        string decisionPath,
        long decisionMs,
        CancellationToken cancellationToken
    )
    {
        var model = ResolveSearchLlmModel();
        var route = "gemini-web-single";
        var chunkIndex = 0;
        Action<string>? deltaCallback = null;
        if (streamCallback != null)
        {
            deltaCallback = delta =>
            {
                if (string.IsNullOrEmpty(delta))
                {
                    return;
                }

                chunkIndex += 1;
                streamCallback(new ChatStreamUpdate(scope, mode, conversationId, "gemini", model, route, delta, chunkIndex));
            };
        }

        var promptStopwatch = Stopwatch.StartNew();
        var prompt = BuildGeminiWebAnswerPrompt(input, memoryHint, selfDecideNeedWeb, allowMarkdownTable, enforceTelegramOutputStyle);
        var maxOutputTokens = ResolveGeminiWebAnswerMaxOutputTokens(input);
        var promptBuildMs = Math.Max(0L, promptStopwatch.ElapsedMilliseconds);
        var response = await _llmRouter.GenerateGeminiGroundedChatStreamingAsync(
            prompt,
            model,
            maxOutputTokens,
            _config.GeminiWebTimeoutMs,
            deltaCallback,
            cancellationToken
        );
        if (IsGeminiWebTimeoutText(response.Text))
        {
            Console.Error.WriteLine($"[gemini] grounded chat timeout retry (model={model})");
            var retryResponse = await _llmRouter.GenerateGeminiGroundedChatStreamingAsync(
                prompt,
                model,
                maxOutputTokens,
                _config.GeminiWebTimeoutMs,
                deltaCallback,
                cancellationToken
            );
            response = new GeminiGroundedChatResponse(
                retryResponse.Text,
                retryResponse.FirstChunkMs > 0
                    ? response.FullResponseMs + retryResponse.FirstChunkMs
                    : 0,
                response.FullResponseMs + retryResponse.FullResponseMs
            );
        }

        var sanitizeStopwatch = Stopwatch.StartNew();
        string outputText;
        if (IsGeminiWebFailureText(response.Text))
        {
            outputText = BuildGeminiWebFailureNotice(input, response.Text);
        }
        else
        {
            outputText = SanitizeChatOutput(response.Text, keepMarkdownTables: allowMarkdownTable);
            outputText = EnsureReadableWebAnswerResponse(outputText, input, allowMarkdownTable);
        }

        var sanitizeMs = Math.Max(0L, sanitizeStopwatch.ElapsedMilliseconds);
        ChatLatencyMetrics? latency = null;
        if (!string.IsNullOrWhiteSpace(decisionPath))
        {
            latency = new ChatLatencyMetrics(
                decisionMs,
                promptBuildMs,
                response.FirstChunkMs,
                response.FullResponseMs,
                sanitizeMs,
                decisionPath
            );
        }

        return new GeminiGroundedWebAnswerResult(
            new LlmSingleChatResult("gemini", model, outputText),
            latency
        );
    }

    private static string EnsureReadableWebAnswerResponse(string text, string input, bool allowMarkdownTable)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return normalized;
        }

        if (allowMarkdownTable && LooksLikeTableRenderRequest(input))
        {
            return EnsureMarkdownTableResponseIfRequested(normalized);
        }

        normalized = RemoveWebAnswerSourceLinkArtifacts(normalized);
        normalized = NormalizeCollapsedWebBulletRuns(normalized);
        if (LooksLikeComparisonRequest(input))
        {
            return normalized;
        }

        if (LooksLikeListOutputRequest(input) || LooksLikeNumberedListResponse(normalized))
        {
            return NormalizeGeminiWebNumberedListResponse(normalized);
        }

        return NormalizeWebAnswerNarrativeParagraphs(normalized);
    }

    private static string NormalizeGeminiWebNumberedListResponse(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Replace("\t", " ", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        normalized = Regex.Replace(
            normalized,
            @"(?<=[.!?]|…)\s*(?=(?:No\.)?\d{1,2}\.\s*(?:\*\*|[A-Za-z가-힣0-9]))",
            "\n\n",
            RegexOptions.CultureInvariant
        );
        normalized = Regex.Replace(
            normalized,
            @"(?m)^(?<n>(?:No\.)?\d{1,2})\.(?=\S)",
            "${n}. ",
            RegexOptions.CultureInvariant
        );
        normalized = MergeDetachedNumberLinesForWeb(normalized);

        var lines = normalized.Split('\n', StringSplitOptions.None);
        if (!LooksLikeNumberedListResponse(normalized))
        {
            return normalized;
        }

        var introParts = new List<string>(8);
        var itemBlocks = new List<string>(12);
        var trailingBlocks = new List<string>(4);
        var currentItem = new StringBuilder();
        var sawItem = false;
        var inTrailing = false;

        void FlushCurrentItem()
        {
            var body = NormalizeGeminiWebListItemBody(currentItem.ToString());
            if (body.Length > 0)
            {
                itemBlocks.Add(body);
            }

            currentItem.Clear();
        }

        foreach (var rawLine in lines)
        {
            var line = (rawLine ?? string.Empty).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (IsGeminiWebListSourceBlock(line))
            {
                FlushCurrentItem();
                inTrailing = true;
                trailingBlocks.Add(line);
                continue;
            }

            if (inTrailing)
            {
                trailingBlocks.Add(line);
                continue;
            }

            if (TryParseGeminiWebListLeadingNumber(line, out _))
            {
                FlushCurrentItem();
                currentItem.Append(StripGeminiWebListLeadingMarker(line));
                sawItem = true;
                continue;
            }

            if (!sawItem)
            {
                introParts.Add(line);
                continue;
            }

            if (currentItem.Length > 0)
            {
                currentItem.Append(' ');
            }

            currentItem.Append(line);
        }

        FlushCurrentItem();
        if (itemBlocks.Count < 2)
        {
            return normalized;
        }

        var output = new List<string>(itemBlocks.Count + trailingBlocks.Count + 2);
        var introBlock = NormalizeGeminiWebListItemBody(string.Join(" ", introParts));
        if (!string.IsNullOrWhiteSpace(introBlock))
        {
            output.Add(introBlock);
        }

        for (var index = 0; index < itemBlocks.Count; index++)
        {
            var body = NormalizeGeminiWebListItemBody(itemBlocks[index]);
            if (body.Length == 0)
            {
                continue;
            }

            output.Add($"{index + 1}. {body}");
        }

        foreach (var trailing in trailingBlocks)
        {
            output.Add(trailing.Trim());
        }

        return string.Join("\n\n", output.Where(block => !string.IsNullOrWhiteSpace(block))).Trim();
    }

    private static string MergeDetachedNumberLinesForWeb(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length);
        for (var i = 0; i < lines.Length; i += 1)
        {
            var current = (lines[i] ?? string.Empty).Trim();
            if (!Regex.IsMatch(current, @"^(?:No\.)?\d+\.$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                output.Add(lines[i]);
                continue;
            }

            var nextIndex = i + 1;
            while (nextIndex < lines.Length && string.IsNullOrWhiteSpace(lines[nextIndex]))
            {
                nextIndex += 1;
            }

            if (nextIndex >= lines.Length)
            {
                output.Add(lines[i]);
                continue;
            }

            var next = (lines[nextIndex] ?? string.Empty).Trim();
            if (next.Length == 0
                || Regex.IsMatch(next, @"^(?:No\.)?\d+\.$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)
                || IsMarkdownTableRow(next))
            {
                output.Add(lines[i]);
                continue;
            }

            output.Add($"{current} {next}");
            i = nextIndex;
        }

        return Regex.Replace(string.Join('\n', output).Trim(), @"\n{3,}", "\n\n");
    }

    private static string NormalizeGeminiWebListItemBody(string value)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        normalized = normalized.Replace("\t", " ", StringComparison.Ordinal);
        normalized = Regex.Replace(normalized, @"\s{2,}", " ").Trim();
        normalized = Regex.Replace(normalized, @"\s+([,.;:!?])", "$1");
        return normalized.Trim();
    }

    private static bool LooksLikeNumberedListResponse(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        normalized = Regex.Replace(
            normalized,
            @"(?<=[.!?]|…)\s*(?=(?:No\.)?\d{1,2}\.\s*(?:\*\*|[A-Za-z가-힣0-9]))",
            "\n",
            RegexOptions.CultureInvariant
        );
        var matches = Regex.Matches(
            normalized,
            @"(?m)^\s*(?:No\.)?\d{1,2}\.\s*(?:\*\*|[A-Za-z가-힣0-9])",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
        );
        return matches.Count >= 2;
    }

    private static bool NeedsGeminiWebListRenumbering(IReadOnlyList<string> itemBlocks)
    {
        if (itemBlocks == null || itemBlocks.Count == 0)
        {
            return false;
        }

        for (var index = 0; index < itemBlocks.Count; index++)
        {
            if (!TryParseGeminiWebListLeadingNumber(itemBlocks[index], out var parsedNumber))
            {
                return true;
            }

            if (parsedNumber != index + 1)
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryParseGeminiWebListLeadingNumber(string value, out int number)
    {
        number = 0;
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        var match = Regex.Match(trimmed, @"^(?:No\.)?(?<n>\d{1,2})\.\s*", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        if (!match.Success)
        {
            return false;
        }

        return int.TryParse(match.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out number);
    }

    private static string StripGeminiWebListLeadingMarker(string value)
    {
        var normalized = (value ?? string.Empty).Trim();
        normalized = Regex.Replace(normalized, @"^(?:No\.)?\d{1,2}\.\s*", string.Empty, RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        return normalized.Trim();
    }

    private static bool IsGeminiWebListIntroBlock(string value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0
            || TryParseGeminiWebListLeadingNumber(trimmed, out _)
            || IsGeminiWebListSourceBlock(trimmed))
        {
            return false;
        }

        var lowered = trimmed.ToLowerInvariant();
        return lowered.Contains("정리해", StringComparison.Ordinal)
            || lowered.Contains("정리했습니다", StringComparison.Ordinal)
            || lowered.Contains("다음과 같습니다", StringComparison.Ordinal)
            || lowered.Contains("주요 뉴스", StringComparison.Ordinal);
    }

    private static bool IsGeminiWebListSourceBlock(string value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        return trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("**출처:**", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeCollapsedWebBulletRuns(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        normalized = Regex.Replace(
            normalized,
            @"(?<=[.!?]|다\.)\s*-\s+(?=[^\n])",
            "\n- ",
            RegexOptions.CultureInvariant
        );
        return Regex.Replace(normalized, @"\n{3,}", "\n\n");
    }

    private static string RemoveWebAnswerSourceLinkArtifacts(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var lines = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length);
        var skipImmediateUrl = false;

        foreach (var raw in lines)
        {
            var trimmed = (raw ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                skipImmediateUrl = false;
                continue;
            }

            if (trimmed.StartsWith("출처 링크:", StringComparison.OrdinalIgnoreCase))
            {
                skipImmediateUrl = true;
                continue;
            }

            var isRawUrlLine = HttpUrlRegex.IsMatch(trimmed)
                && HttpUrlRegex.Match(trimmed).Value.Equals(trimmed, StringComparison.Ordinal);
            if (skipImmediateUrl && isRawUrlLine)
            {
                skipImmediateUrl = false;
                continue;
            }

            skipImmediateUrl = false;

            if (trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                var cleanedSource = Regex.Replace(trimmed["출처:".Length..].Trim(), @"https?://\S+", string.Empty);
                cleanedSource = cleanedSource.Replace("**", string.Empty, StringComparison.Ordinal);
                cleanedSource = Regex.Replace(cleanedSource, @"\s{2,}", " ").Trim().Trim(',', ';', '|', '/');
                if (cleanedSource.Length == 0)
                {
                    continue;
                }

                output.Add($"출처: {cleanedSource}");
                continue;
            }

            if (isRawUrlLine
                && output.Count > 0
                && output[^1].StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            output.Add(trimmed);
        }

        return Regex.Replace(string.Join('\n', output).Trim(), @"\n{3,}", "\n\n");
    }

    private static string NormalizeWebAnswerNarrativeParagraphs(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var lines = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length + 4);
        var paragraphParts = new List<string>(8);

        void FlushParagraph()
        {
            if (paragraphParts.Count == 0)
            {
                return;
            }

            var merged = string.Join(" ", paragraphParts.Where(part => !string.IsNullOrWhiteSpace(part)).Select(part => part.Trim()));
            merged = Regex.Replace(merged, @"\s{2,}", " ").Trim();
            merged = Regex.Replace(merged, @"\s+([,.;:!?])", "$1");
            if (merged.Length > 0)
            {
                output.Add(merged);
            }

            paragraphParts.Clear();
        }

        foreach (var raw in lines)
        {
            var trimmed = (raw ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                FlushParagraph();
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                continue;
            }

            if (IsNarrativeWebAnswerLine(trimmed))
            {
                paragraphParts.Add(trimmed);
                continue;
            }

            FlushParagraph();
            if (TryNormalizeWebAnswerStructuredLabelLine(trimmed, out var normalizedStructuredLine))
            {
                if (output.Count > 0
                    && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                output.Add(normalizedStructuredLine);
                continue;
            }

            output.Add(trimmed);
        }

        FlushParagraph();
        return Regex.Replace(string.Join('\n', output).Trim(), @"\n{3,}", "\n\n");
    }

    private static bool TryNormalizeWebAnswerStructuredLabelLine(string line, out string normalizedLine)
    {
        normalizedLine = string.Empty;
        var trimmed = (line ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        if (TryNormalizeExistingStructuredMarkdownLabelLine(trimmed, out normalizedLine))
        {
            return true;
        }

        return TryFormatStructuredMarkdownLabelLine(trimmed, out normalizedLine);
    }

    private static bool IsNarrativeWebAnswerLine(string line)
    {
        var trimmed = (line ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        if (trimmed.StartsWith("```", StringComparison.Ordinal)
            || IsMarkdownTableRow(trimmed)
            || trimmed.StartsWith("요약:", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("핵심:", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("**핵심:**", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (Regex.IsMatch(trimmed, @"^(?:[-•▪*]\s+|\d+[.)]\s+)", RegexOptions.CultureInvariant))
        {
            return false;
        }

        if (Regex.IsMatch(
                trimmed,
                @"^(?:\*\*)?\s*[A-Za-z가-힣0-9(][A-Za-z가-힣0-9(),.&+_/\-·\s]{0,40}\s*(?:\*\*)?\s*[:：]",
                RegexOptions.CultureInvariant))
        {
            return false;
        }

        return !HttpUrlRegex.IsMatch(trimmed);
    }

    private static string EnsureMarkdownTableResponseIfRequested(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        normalized = ConvertDelimitedPlainTextTableToMarkdown(normalized);

        var hasTableHeader = Regex.IsMatch(normalized, @"(?m)^\s*\|.+\|\s*$", RegexOptions.CultureInvariant);
        var hasTableSeparator = Regex.IsMatch(
            normalized,
            @"(?m)^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$",
            RegexOptions.CultureInvariant
        );
        if (hasTableHeader && hasTableSeparator)
        {
            return NormalizeMarkdownTableResponseMetadata(normalized);
        }

        var sourceNames = new List<string>(8);
        var intro = new List<string>(4);
        var rows = new List<(string Key, string Value)>(8);
        var currentSection = string.Empty;
        var currentSectionItems = new List<string>(4);
        var metadataSection = string.Empty;

        static string NormalizeMetadataLabel(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var normalized = Regex.Replace(value, @"[*`_~\[\]\(\)]", string.Empty);
            normalized = Regex.Replace(normalized, @"\s+", string.Empty);
            return normalized.Trim().ToLowerInvariant();
        }

        static bool IsSourceMetadataLabel(string label)
        {
            var normalized = NormalizeMetadataLabel(label);
            return normalized.StartsWith("출처", StringComparison.Ordinal)
                || normalized.Equals("source", StringComparison.Ordinal)
                || normalized.Equals("sources", StringComparison.Ordinal);
        }

        static bool IsSummaryMetadataLabel(string label)
        {
            var normalized = NormalizeMetadataLabel(label);
            return normalized.StartsWith("요약", StringComparison.Ordinal)
                || normalized.Equals("summary", StringComparison.Ordinal);
        }

        static string StripListPrefix(string value)
        {
            var normalized = (value ?? string.Empty).Trim();
            normalized = Regex.Replace(normalized, @"^(?:[-•▪●◆▶▷]\s*)+", string.Empty);
            return normalized.Trim();
        }

        void AppendSourceNames(string rawValue)
        {
            var normalized = StripListPrefix(rawValue);
            if (normalized.Length == 0)
            {
                return;
            }

            normalized = Regex.Replace(normalized, @"^(?:\*\*)?\s*출처\s*(?:\*\*)?\s*[:：]\s*", string.Empty, RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            normalized = Regex.Replace(normalized, @"\s{2,}", " ");
            if (normalized.Length == 0)
            {
                return;
            }

            foreach (var token in normalized.Split(new[] { ',', '·', '/', '|' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var name = token.Trim();
                if (name.Length == 0)
                {
                    continue;
                }

                if (name.StartsWith("출처", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                sourceNames.Add(name);
            }
        }

        void FlushSection()
        {
            if (string.IsNullOrWhiteSpace(currentSection))
            {
                currentSectionItems.Clear();
                return;
            }

            var value = currentSectionItems.Count == 0
                ? "-"
                : string.Join(" / ", currentSectionItems.Where(item => !string.IsNullOrWhiteSpace(item)).Select(item => item.Trim()));
            value = string.IsNullOrWhiteSpace(value) ? "-" : value;
            rows.Add((SanitizeTableCell(currentSection), SanitizeTableCell(value)));
            currentSection = string.Empty;
            currentSectionItems.Clear();
        }

        var lines = normalized.Split('\n', StringSplitOptions.None);
        foreach (var raw in lines)
        {
            var line = (raw ?? string.Empty).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (metadataSection.Equals("source", StringComparison.Ordinal))
            {
                AppendSourceNames(line);
                continue;
            }

            if (metadataSection.Equals("summary", StringComparison.Ordinal))
            {
                var summaryValue = StripListPrefix(line);
                if (summaryValue.Length > 0)
                {
                    intro.Add(summaryValue);
                }
                continue;
            }

            var sectionMatch = Regex.Match(line, @"^(?:[■□▪●◆▶▷]\s*)+(?<section>.+)$", RegexOptions.CultureInvariant);
            if (sectionMatch.Success)
            {
                FlushSection();
                var sectionName = sectionMatch.Groups["section"].Value.Trim();
                if (IsSourceMetadataLabel(sectionName))
                {
                    metadataSection = "source";
                    continue;
                }

                if (IsSummaryMetadataLabel(sectionName))
                {
                    metadataSection = "summary";
                    continue;
                }

                metadataSection = string.Empty;
                currentSection = sectionName;
                continue;
            }

            var bulletMatch = Regex.Match(line, @"^(?:[-•·●]\s*)(?<body>.+)$", RegexOptions.CultureInvariant);
            if (bulletMatch.Success)
            {
                var body = bulletMatch.Groups["body"].Value.Trim();
                if (body.Length == 0)
                {
                    continue;
                }

                if (!string.IsNullOrWhiteSpace(currentSection))
                {
                    currentSectionItems.Add(body);
                    continue;
                }

                var keyValueBullet = Regex.Match(body, @"^(?<k>[^:：]{1,40})\s*[:：]\s*(?<v>.+)$", RegexOptions.CultureInvariant);
                if (keyValueBullet.Success)
                {
                    var key = keyValueBullet.Groups["k"].Value.Trim();
                    var value = keyValueBullet.Groups["v"].Value.Trim();
                    if (IsSourceMetadataLabel(key))
                    {
                        AppendSourceNames(value);
                        continue;
                    }

                    if (IsSummaryMetadataLabel(key))
                    {
                        if (value.Length > 0)
                        {
                            intro.Add($"요약: {value}");
                        }

                        continue;
                    }

                    rows.Add((
                        SanitizeTableCell(key),
                        SanitizeTableCell(value)
                    ));
                }
                else
                {
                    rows.Add(("핵심", SanitizeTableCell(body)));
                }

                continue;
            }

            if (!string.IsNullOrWhiteSpace(currentSection))
            {
                currentSectionItems.Add(line);
                continue;
            }

            var keyValueLine = Regex.Match(
                line,
                @"^(?:\*\*)?\s*(?<k>[^:：]{1,40})\s*(?:\*\*)?\s*[:：]\s*(?<v>.+)$",
                RegexOptions.CultureInvariant
            );
            if (keyValueLine.Success)
            {
                var key = keyValueLine.Groups["k"].Value.Trim();
                var value = keyValueLine.Groups["v"].Value.Trim();
                if (IsSourceMetadataLabel(key))
                {
                    AppendSourceNames(value);
                    continue;
                }

                if (IsSummaryMetadataLabel(key))
                {
                    if (value.Length > 0)
                    {
                        intro.Add($"요약: {value}");
                    }

                    continue;
                }
            }

            intro.Add(line);
        }

        FlushSection();

        if (rows.Count == 0)
        {
            return normalized;
        }

        var output = new List<string>(rows.Count + 6);
        if (intro.Count > 0)
        {
            output.AddRange(intro.Take(2));
            output.Add(string.Empty);
        }

        output.Add("| 구분 | 주요 내용 |");
        output.Add("| --- | --- |");
        foreach (var row in rows)
        {
            output.Add($"| {row.Key} | {row.Value} |");
        }

        var distinctSources = sourceNames
            .Select(value => value.Trim())
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (distinctSources.Count > 0)
        {
            output.Add(string.Empty);
            output.Add($"출처: {string.Join(", ", distinctSources)}");
        }

        return string.Join('\n', output).Trim();
    }

    private static string ConvertDelimitedPlainTextTableToMarkdown(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length + 4);
        var index = 0;
        while (index < lines.Length)
        {
            if (!TrySplitDelimitedTableRow(lines[index], out var headerCells, out var delimiterKind))
            {
                output.Add(lines[index]);
                index += 1;
                continue;
            }

            var rows = new List<string[]>(8);
            var cursor = index + 1;
            while (cursor < lines.Length
                && TrySplitDelimitedTableRow(lines[cursor], out var rowCells, out var rowDelimiterKind)
                && rowDelimiterKind == delimiterKind
                && rowCells.Length == headerCells.Length)
            {
                rows.Add(rowCells);
                cursor += 1;
            }

            if (rows.Count == 0)
            {
                output.Add(lines[index]);
                index += 1;
                continue;
            }

            output.Add($"| {string.Join(" | ", headerCells.Select(SanitizeTableCell))} |");
            output.Add($"| {string.Join(" | ", Enumerable.Repeat("---", headerCells.Length))} |");
            foreach (var row in rows)
            {
                output.Add($"| {string.Join(" | ", row.Select(SanitizeTableCell))} |");
            }

            index = cursor;
        }

        return string.Join('\n', output).Trim();
    }

    private static bool TrySplitDelimitedTableRow(string line, out string[] cells, out string delimiterKind)
    {
        cells = Array.Empty<string>();
        delimiterKind = string.Empty;

        var trimmed = (line ?? string.Empty).Trim();
        if (trimmed.Length == 0
            || trimmed.StartsWith("|", StringComparison.Ordinal)
            || Regex.IsMatch(trimmed, @"^(?:[-•▪*]\s+|\d+[.)]\s+)", RegexOptions.CultureInvariant)
            || Regex.IsMatch(trimmed, @"^(?:\*\*)?\s*[A-Za-z가-힣0-9(][A-Za-z가-힣0-9().&+_/\-·\s]{0,40}\s*(?:\*\*)?\s*[:：]", RegexOptions.CultureInvariant)
            || HttpUrlRegex.IsMatch(trimmed))
        {
            return false;
        }

        if (trimmed.Contains('\t'))
        {
            var tabCells = trimmed
                .Split('\t', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(cell => cell.Trim())
                .Where(cell => cell.Length > 0)
                .ToArray();
            if (tabCells.Length >= 3)
            {
                cells = tabCells;
                delimiterKind = "tab";
                return true;
            }
        }

        var spaceCells = Regex.Split(trimmed, @"\s{2,}", RegexOptions.CultureInvariant)
            .Select(cell => cell.Trim())
            .Where(cell => cell.Length > 0)
            .ToArray();
        if (spaceCells.Length >= 3)
        {
            cells = spaceCells;
            delimiterKind = "space";
            return true;
        }

        return false;
    }

    private static string NormalizeMarkdownTableResponseMetadata(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return normalized;
        }

        static string NormalizeLabel(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var normalizedValue = Regex.Replace(value, @"[*`_~\[\]\(\)]", string.Empty);
            normalizedValue = Regex.Replace(normalizedValue, @"\s+", string.Empty);
            return normalizedValue.Trim().ToLowerInvariant();
        }

        static bool IsSourceLabel(string value)
        {
            var normalizedValue = NormalizeLabel(value);
            return normalizedValue.StartsWith("출처", StringComparison.Ordinal)
                || normalizedValue.Equals("source", StringComparison.Ordinal)
                || normalizedValue.Equals("sources", StringComparison.Ordinal);
        }

        static bool StartsWithSourceMetadata(string value)
        {
            var trimmed = (value ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                return false;
            }

            return Regex.IsMatch(
                trimmed,
                @"^(?:\*\*)?\s*(?:출처|sources?)\s*(?:\*\*)?\s*[:：]",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
            );
        }

        static string[] ParseCells(string line)
        {
            var trimmed = (line ?? string.Empty).Trim();
            if (trimmed.StartsWith("|", StringComparison.Ordinal))
            {
                trimmed = trimmed[1..];
            }

            if (trimmed.EndsWith("|", StringComparison.Ordinal))
            {
                trimmed = trimmed[..^1];
            }

            return trimmed
                .Split('|', StringSplitOptions.None)
                .Select(cell => cell.Trim())
                .ToArray();
        }

        static string BuildRow(IReadOnlyList<string> cells)
        {
            return $"| {string.Join(" | ", cells.Select(cell => SanitizeTableCell(cell)))} |";
        }

        static bool IsTableRow(string line)
        {
            var trimmed = (line ?? string.Empty).Trim();
            if (trimmed.Length < 3)
            {
                return false;
            }

            if (!trimmed.StartsWith("|", StringComparison.Ordinal) || !trimmed.EndsWith("|", StringComparison.Ordinal))
            {
                return false;
            }

            return trimmed.Count(ch => ch == '|') >= 2;
        }

        static bool IsTableSeparator(string line)
        {
            var trimmed = (line ?? string.Empty).Trim();
            if (!IsTableRow(trimmed))
            {
                return false;
            }

            var cells = ParseCells(trimmed);
            if (cells.Length == 0)
            {
                return false;
            }

            foreach (var cell in cells)
            {
                var compact = cell.Replace(" ", string.Empty, StringComparison.Ordinal);
                if (compact.Length < 3 || !Regex.IsMatch(compact, @"^:?-{3,}:?$", RegexOptions.CultureInvariant))
                {
                    return false;
                }
            }

            return true;
        }

        static void AppendSourceNames(List<string> bucket, string rawValue)
        {
            var normalizedValue = (rawValue ?? string.Empty).Trim();
            normalizedValue = Regex.Replace(
                normalizedValue,
                @"^(?:\*\*)?\s*(?:출처|sources?)\s*(?:\*\*)?\s*[:：]\s*",
                string.Empty,
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
            );
            if (normalizedValue.Length == 0)
            {
                return;
            }

            var split = normalizedValue.Split(new[] { ',', '·', '/', '|', ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var token in split)
            {
                var name = token.Trim();
                if (name.Length == 0)
                {
                    continue;
                }

                if (name.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    || name.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (name.StartsWith("출처", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                bucket.Add(name);
            }
        }

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var tableStart = -1;
        var tableEnd = -1;
        for (var i = 0; i < lines.Length - 1; i++)
        {
            if (!IsTableRow(lines[i]) || !IsTableSeparator(lines[i + 1]))
            {
                continue;
            }

            tableStart = i;
            var cursor = i + 2;
            while (cursor < lines.Length && IsTableRow(lines[cursor]))
            {
                cursor++;
            }

            tableEnd = cursor - 1;
            break;
        }

        if (tableStart < 0 || tableEnd < tableStart + 1)
        {
            return normalized;
        }

        var sourceNames = new List<string>(8);
        var beforeLines = new List<string>(Math.Max(0, tableStart));
        var afterLines = new List<string>(Math.Max(0, lines.Length - tableEnd - 1));

        for (var i = 0; i < tableStart; i++)
        {
            var trimmed = lines[i].Trim();
            if (trimmed.Length > 0
                && Regex.IsMatch(trimmed, @"^(?:\*\*)?\s*(?:출처|sources?)\s*(?:\*\*)?\s*[:：]", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                AppendSourceNames(sourceNames, trimmed);
                continue;
            }

            beforeLines.Add(lines[i]);
        }

        for (var i = tableEnd + 1; i < lines.Length; i++)
        {
            var trimmed = lines[i].Trim();
            if (trimmed.Length > 0
                && Regex.IsMatch(trimmed, @"^(?:\*\*)?\s*(?:출처|sources?)\s*(?:\*\*)?\s*[:：]", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                AppendSourceNames(sourceNames, trimmed);
                continue;
            }

            afterLines.Add(lines[i]);
        }

        var headerCells = ParseCells(lines[tableStart]);
        if (headerCells.Length == 0)
        {
            return normalized;
        }

        var sourceColumnIndexes = headerCells
            .Select((cell, index) => (cell, index))
            .Where(item => IsSourceLabel(item.cell))
            .Select(item => item.index)
            .ToHashSet();

        var keepColumnIndexes = Enumerable.Range(0, headerCells.Length)
            .Where(index => !sourceColumnIndexes.Contains(index))
            .ToArray();

        if (keepColumnIndexes.Length == 0)
        {
            return normalized;
        }

        var rebuiltDataRows = new List<string[]>(Math.Max(0, tableEnd - tableStart - 1));
        var movedFromTable = sourceColumnIndexes.Count > 0;
        for (var i = tableStart + 2; i <= tableEnd; i++)
        {
            var parsed = ParseCells(lines[i]);
            var rowCells = new string[headerCells.Length];
            for (var col = 0; col < headerCells.Length; col++)
            {
                rowCells[col] = col < parsed.Length ? parsed[col] : string.Empty;
            }

            var mergedRowText = string.Join(", ", rowCells.Where(value => !string.IsNullOrWhiteSpace(value)));
            var isSourceMetadataRow = rowCells.Any(StartsWithSourceMetadata)
                || (rowCells.Length > 0 && IsSourceLabel(rowCells[0]));
            if (isSourceMetadataRow)
            {
                AppendSourceNames(sourceNames, mergedRowText);
                movedFromTable = true;
                continue;
            }

            foreach (var sourceIndex in sourceColumnIndexes)
            {
                if (sourceIndex >= 0 && sourceIndex < rowCells.Length)
                {
                    AppendSourceNames(sourceNames, rowCells[sourceIndex]);
                }
            }

            var filtered = keepColumnIndexes.Select(index => rowCells[index]).ToArray();
            if (filtered.All(value => string.IsNullOrWhiteSpace(value)))
            {
                continue;
            }

            rebuiltDataRows.Add(filtered);
        }

        if (!movedFromTable && sourceNames.Count == 0)
        {
            return normalized;
        }

        var rebuilt = new List<string>(lines.Length + 4);
        rebuilt.AddRange(beforeLines);

        var filteredHeader = keepColumnIndexes.Select(index => headerCells[index]).ToArray();
        rebuilt.Add(BuildRow(filteredHeader));
        rebuilt.Add(BuildRow(Enumerable.Repeat("---", filteredHeader.Length).ToArray()));
        foreach (var row in rebuiltDataRows)
        {
            rebuilt.Add(BuildRow(row));
        }

        rebuilt.AddRange(afterLines);

        var distinctSources = sourceNames
            .Select(value => value.Trim())
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (distinctSources.Count > 0)
        {
            if (rebuilt.Count > 0 && !string.IsNullOrWhiteSpace(rebuilt[^1]))
            {
                rebuilt.Add(string.Empty);
            }

            rebuilt.Add($"출처: {string.Join(", ", distinctSources)}");
        }

        return string.Join('\n', rebuilt).Trim();
    }

    private static string SanitizeTableCell(string value)
    {
        var normalized = (value ?? string.Empty)
            .Replace('\n', ' ')
            .Replace('\r', ' ')
            .Replace("|", "/", StringComparison.Ordinal)
            .Trim();
        normalized = Regex.Replace(normalized, @"\s{2,}", " ");
        return normalized.Length == 0 ? "-" : normalized;
    }

    private string BuildGeminiUrlContextAnswerPrompt(
        string input,
        IReadOnlyList<string> urls,
        string memoryHint,
        bool allowMarkdownTable,
        bool enforceTelegramOutputStyle,
        bool includeGoogleSearch
    )
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var normalizedMemoryHint = (memoryHint ?? string.Empty).Trim();
        var hasExplicitCount = HasExplicitRequestedCountInQuery(normalizedInput);
        var requestedCount = hasExplicitCount
            ? Math.Clamp(ResolveRequestedResultCountFromQuery(normalizedInput), 1, 20)
            : ResolveWebDefaultCount(normalizedInput);
        var listMode = LooksLikeListOutputRequest(normalizedInput);
        var tableMode = allowMarkdownTable && LooksLikeTableRenderRequest(normalizedInput);
        var comparisonMode = LooksLikeComparisonRequest(normalizedInput);
        var primaryUrl = urls.FirstOrDefault() ?? string.Empty;
        var siteOverviewMode = urls.Count == 1 && LooksLikeSiteOverviewRequest(normalizedInput) && LooksLikeSiteRootUrl(primaryUrl);
        var documentMode = urls.Count == 1 && LooksLikeDocumentationUrl(primaryUrl);
        var articleMode = urls.Count == 1 && LooksLikeArticleUrl(primaryUrl);

        var builder = new StringBuilder();
        builder.AppendLine("너는 URL 컨텍스트 기반 한국어 답변기다.");
        builder.AppendLine("- 아래 참조 URL 내용이 1차 근거다.");
        if (includeGoogleSearch)
        {
            builder.AppendLine("- google_search가 가능하면 배경 보강이나 최신성 확인에만 보조적으로 사용해라.");
            builder.AppendLine("- URL에 없는 내용은 추정하지 말고, 검색으로도 확인되지 않으면 없다고 말해라.");
        }
        else
        {
            builder.AppendLine("- URL에 없는 내용은 추정하지 말고, URL에서 직접 확인되지 않으면 없다고 말해라.");
        }
        builder.AppendLine("- 허위/기억 기반 문장 금지.");
        builder.AppendLine("- 출처는 URL이 아닌 도메인명으로만 작성해라.");
        builder.AppendLine("- 출처 표기는 마지막 한 줄 형식으로만 작성: '출처: 도메인1, 도메인2'.");
        builder.AppendLine("- '출처 링크:' 섹션이나 URL 단독 줄을 만들지 마라.");
        builder.AppendLine("- 문장 중간을 임의로 줄바꿈하지 말고 자연스러운 한국어 문장으로 정리해라.");
        builder.AppendLine("- 답변이 길어질 것 같으면 항목 수를 줄이고 요약해서 문장을 끝까지 완성해라.");
        builder.AppendLine("- 페이지의 제목, 목적, 핵심 내용, 중요한 세부사항이 무엇인지 요약하면서도 분명하게 드러내라.");
        builder.AppendLine("- 본문에서 임의의 '**' 강조를 남발하지 말고, 구조 라벨이나 항목 제목에만 제한적으로 사용해라.");
        if (tableMode)
        {
            builder.AppendLine("- 사용자가 표를 요청했으므로 반드시 GitHub 마크다운 표로 작성해라.");
            builder.AppendLine("- 표의 헤더/구분선/데이터 행은 모두 '|'로 시작하고 '|'로 끝내라.");
            builder.AppendLine("- 표를 코드블록으로 감싸지 마라.");
            builder.AppendLine("- 표 안에 '출처' 열이나 '출처' 행을 만들지 마라.");
        }
        else
        {
            builder.AppendLine("- 사용자가 표를 요청하지 않았다면 표/ASCII 테이블 형식은 쓰지 마라.");
        }
        if (enforceTelegramOutputStyle)
        {
            builder.AppendLine("- 출력 채널은 텔레그램이다. 군더더기 머리말 없이 바로 본문 형식으로 작성해라.");
        }
        if (siteOverviewMode)
        {
            builder.AppendLine("- 이 요청은 사이트/서비스 소개 요청이다.");
            builder.AppendLine("- 해당 사이트가 무엇을 하는지, 핵심 제품/기능, 누구를 위한 서비스인지, 눈여겨볼 점을 정리해라.");
        }
        else if (documentMode)
        {
            builder.AppendLine("- 이 요청은 문서/가이드 설명 요청이다.");
            builder.AppendLine("- 문서의 목적, 어떤 기능을 설명하는지, 사용 흐름, 지원 대상, 제한/주의점을 정리해라.");
        }
        else if (articleMode)
        {
            builder.AppendLine("- 이 요청은 기사/게시물 요약 요청이다.");
            builder.AppendLine("- 핵심 사실, 주요 인물/기관, 중요한 수치/날짜, 왜 중요한지를 우선 정리해라.");
        }

        if (tableMode)
        {
            builder.AppendLine("요약: <1문장>");
            builder.AppendLine();
            builder.AppendLine("| 항목 | 내용 |");
            builder.AppendLine("| --- | --- |");
            builder.AppendLine("| 예시 | 값 |");
            builder.AppendLine();
            builder.AppendLine("출처: 도메인1, 도메인2");
            if (listMode)
            {
                builder.AppendLine($"- 표의 데이터 행은 가능하면 {requestedCount}개로 맞춰라.");
            }
        }
        else if (listMode)
        {
            builder.AppendLine($"- 목록 모드: 목표 {requestedCount}건.");
            builder.AppendLine("- 각 항목은 제목과 핵심 내용만 간결하게 정리해라.");
        }
        else
        {
            builder.AppendLine("- 일반 검색형 답변은 아래 형식만 사용해라.");
            builder.AppendLine("요약: <2~3문장>");
            builder.AppendLine();
            builder.AppendLine("무엇을 다루나: <1~2문장>");
            builder.AppendLine();
            builder.AppendLine("핵심:");
            builder.AppendLine("- <핵심 포인트 3~5개>");
            builder.AppendLine("- <핵심 포인트>");
            builder.AppendLine();
            builder.AppendLine("중요 포인트:");
            builder.AppendLine("- <사용자가 바로 알아야 할 점>");
            builder.AppendLine();
            builder.AppendLine("출처: 도메인1, 도메인2");
            if (comparisonMode)
            {
                builder.AppendLine("- 비교/분류형 답변이면 항목별 줄바꿈을 유지해라.");
            }
        }

        if (normalizedMemoryHint.Length > 0)
        {
            builder.AppendLine();
            builder.AppendLine("사용자 선호 메모리(보조 규칙, 충돌 시 무시):");
            builder.AppendLine(normalizedMemoryHint);
        }

        builder.AppendLine();
        builder.AppendLine("참조 URL:");
        foreach (var url in urls.Take(3))
        {
            builder.AppendLine($"- {url}");
        }
        builder.AppendLine();
        builder.AppendLine("사용자 입력:");
        builder.AppendLine(normalizedInput);
        return builder.ToString().Trim();
    }

    private static bool LooksLikeSiteOverviewRequest(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            normalized,
            "이 사이트",
            "사이트 내용",
            "사이트 설명",
            "사이트 알려",
            "서비스 설명",
            "회사 소개",
            "기업 소개",
            "무슨 사이트",
            "무슨 서비스"
        );
    }

    private static bool LooksLikeSiteRootUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var path = (uri.AbsolutePath ?? string.Empty).Trim();
        return path.Length == 0 || path == "/";
    }

    private static bool LooksLikeDocumentationUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var host = (uri.Host ?? string.Empty).ToLowerInvariant();
        var path = (uri.AbsolutePath ?? string.Empty).ToLowerInvariant();
        return ContainsAny(host, "developers", "docs", "api")
               || ContainsAny(path, "/docs", "/doc", "/api", "/guide", "/reference", "/tutorial");
    }

    private static bool LooksLikeArticleUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var host = (uri.Host ?? string.Empty).ToLowerInvariant();
        var path = (uri.AbsolutePath ?? string.Empty).ToLowerInvariant();
        return ContainsAny(host, "news", "blog", "medium", "substack")
               || ContainsAny(path, "/article", "/news", "/blog", "/posts", "/post");
    }

    private string BuildGeminiWebAnswerPrompt(
        string input,
        string memoryHint,
        bool selfDecideNeedWeb,
        bool allowMarkdownTable,
        bool enforceTelegramOutputStyle
    )
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var normalizedMemoryHint = (memoryHint ?? string.Empty).Trim();
        var hasExplicitCount = HasExplicitRequestedCountInQuery(normalizedInput);
        var requestedCount = hasExplicitCount
            ? Math.Clamp(ResolveRequestedResultCountFromQuery(normalizedInput), 1, 20)
            : ResolveWebDefaultCount(normalizedInput);
        var sourceFocus = ExtractSourceFocusHintFromInput(normalizedInput);
        var sourceDomain = ResolveSourceDomainFromQueryOrFocus(normalizedInput, sourceFocus);
        var listMode = LooksLikeListOutputRequest(normalizedInput);
        var tableMode = allowMarkdownTable && LooksLikeTableRenderRequest(normalizedInput);
        var comparisonMode = LooksLikeComparisonRequest(normalizedInput);

        var builder = new StringBuilder();
        builder.AppendLine("너는 최신 웹 근거 기반 한국어 답변기다.");
        builder.AppendLine("- 현재 사용자 입력을 최우선으로 따른다.");
        builder.AppendLine("- 선호 메모리가 있더라도 현재 입력과 충돌하면 즉시 무시한다.");
        builder.AppendLine("- 사실/수치/날짜/가격/사건 정보는 웹 근거만 사용하고 추정하지 마라.");
        if (selfDecideNeedWeb)
        {
            builder.AppendLine("- 먼저 사용자 입력만 보고 웹검색 필요 여부를 스스로 판단해라.");
            builder.AppendLine("- 웹검색이 불필요하면 도구 호출 없이 바로 답변해라.");
        }
        else
        {
            builder.AppendLine("- 이번 요청은 웹검색으로만 답변해라.");
        }

        builder.AppendLine("- 허위/기억 기반 문장 금지.");
        builder.AppendLine("- 출처는 URL이 아닌 매체명으로만 작성해라.");
        builder.AppendLine("- 출처 표기는 마지막 한 줄 형식으로만 작성: '출처: 매체1, 매체2, 매체3'.");
        builder.AppendLine("- '출처 링크:' 섹션이나 URL 단독 줄을 만들지 마라.");
        builder.AppendLine("- 문장 중간을 임의로 줄바꿈하지 말고 자연스러운 한국어 문장으로 정리해라.");
        if (tableMode)
        {
            builder.AppendLine("- 사용자가 표를 요청했으므로 반드시 GitHub 마크다운 표로 작성해라.");
            builder.AppendLine("- 표의 헤더/구분선/데이터 행은 모두 '|'로 시작하고 '|'로 끝내라.");
            builder.AppendLine("- 표를 코드블록으로 감싸지 마라.");
            builder.AppendLine("- 표 안에 '출처' 열이나 '출처' 행을 만들지 마라.");
            builder.AppendLine("- 표 요청 응답에서는 불릿 목록으로 대체하지 마라.");
            builder.AppendLine("- 표가 필요한 정보는 반드시 표의 행/열로 정리해라.");
        }
        else
        {
            builder.AppendLine("- 사용자가 표를 요청하지 않았다면 표/ASCII 테이블 형식은 쓰지 마라.");
        }
        if (enforceTelegramOutputStyle)
        {
            builder.AppendLine("- 출력 채널은 텔레그램이다. 군더더기 머리말 없이 바로 본문 형식으로 작성해라.");
            builder.AppendLine("- URL 본문 노출은 금지하고 매체명만 사용해라.");
        }
        if (sourceFocus.Length > 0)
        {
            builder.AppendLine($"- 사용자가 요구한 소스 초점: {sourceFocus}");
            if (sourceDomain.Length > 0)
            {
                builder.AppendLine($"- 가능한 경우 {sourceDomain} 원출처 기사 우선.");
            }
        }

        if (tableMode)
        {
            builder.AppendLine("- 표 요청 모드: 아래 형식만 사용해라.");
            builder.AppendLine("요약: <1문장>");
            builder.AppendLine();
            builder.AppendLine("| 항목 | 내용 |");
            builder.AppendLine("| --- | --- |");
            builder.AppendLine("| 예시 | 값 |");
            builder.AppendLine();
            builder.AppendLine("출처: 매체1, 매체2");
            builder.AppendLine("- 표 앞뒤에 불릿 목록을 쓰지 마라.");
            builder.AppendLine("- 가능한 경우 실제 데이터 열 이름을 사용해 3열 이상 표로 확장해라.");
            if (listMode)
            {
                builder.AppendLine($"- 표의 데이터 행은 가능하면 {requestedCount}개로 맞춰라.");
            }
        }
        else if (listMode)
        {
            builder.AppendLine($"- 목록 모드: 목표 {requestedCount}건.");
            builder.AppendLine("- 각 항목은 제목과 핵심 내용만 간결하게 정리해라.");
            if (hasExplicitCount)
            {
                builder.AppendLine($"- 사용자가 건수를 명시했으므로 가능하면 정확히 {requestedCount}건을 작성해라.");
            }
            else
            {
                builder.AppendLine($"- 건수 미지정 요청이므로 기본 {requestedCount}건으로 작성해라.");
            }
        }
        else
        {
            builder.AppendLine("- 일반 질의 모드: 핵심 답변을 간결하게 작성해라.");
            if (comparisonMode)
            {
                builder.AppendLine("- 비교/분류형 답변이면 항목별 줄바꿈을 유지해라.");
            }
            else
            {
                builder.AppendLine("- 일반 검색형 답변은 아래 형식만 사용해라.");
                builder.AppendLine("요약: <1~2문장>");
                builder.AppendLine();
                builder.AppendLine("핵심:");
                builder.AppendLine("- <핵심 포인트>");
                builder.AppendLine("- <핵심 포인트>");
                builder.AppendLine();
                builder.AppendLine("출처: 매체1, 매체2");
                builder.AppendLine("- 위 형식 외의 제목/머리말/날짜 안내문은 추가하지 마라.");
            }
        }

        if (normalizedMemoryHint.Length > 0)
        {
            builder.AppendLine();
            builder.AppendLine("사용자 선호 메모리(보조 규칙, 충돌 시 무시):");
            builder.AppendLine(normalizedMemoryHint);
        }

        builder.AppendLine();
        builder.AppendLine("사용자 입력:");
        builder.AppendLine(normalizedInput);
        return builder.ToString().Trim();
    }

    private string BuildSafeWebMemoryPreferenceHint(
        string conversationId,
        string currentInput,
        IReadOnlyList<string>? linkedMemoryNotes
    )
    {
        var normalizedInput = (currentInput ?? string.Empty).Trim();
        if (normalizedInput.Length == 0)
        {
            return string.Empty;
        }

        if (ShouldBlockWebMemoryHintByOverride(normalizedInput))
        {
            return string.Empty;
        }

        var sourceFocus = ExtractSourceFocusHintFromInput(normalizedInput);
        var sourceDomain = ResolveSourceDomainFromQueryOrFocus(normalizedInput, sourceFocus);
        var hasSourceOverride = sourceFocus.Length > 0
            || sourceDomain.Length > 0
            || normalizedInput.Contains("site:", StringComparison.OrdinalIgnoreCase);
        var hasCountOverride = HasExplicitRequestedCountInQuery(normalizedInput);
        var hasFormatOverride = LooksLikeWebFormatDirective(normalizedInput);
        var hasToneOverride = LooksLikeWebToneDirective(normalizedInput);
        var hasLanguageOverride = LooksLikeWebLanguageDirective(normalizedInput);
        var shouldReadMemoryHint = hasSourceOverride || hasFormatOverride || hasToneOverride || hasLanguageOverride;
        if (!shouldReadMemoryHint)
        {
            return string.Empty;
        }

        var candidates = new List<WebPreferenceHint>(16);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var thread = _conversationStore.Get(conversationId);
        if (thread is not null)
        {
            var recentUserMessages = thread.Messages
                .Where(msg => msg.Role.Equals("user", StringComparison.OrdinalIgnoreCase))
                .Select(msg => (msg.Text ?? string.Empty).Trim())
                .Where(text => text.Length > 0 && !text.Equals(normalizedInput, StringComparison.Ordinal))
                .Reverse()
                .Take(8)
                .ToArray();
            foreach (var message in recentUserMessages)
            {
                foreach (var hint in ExtractWebPreferenceHints(message, fromMemoryNote: false))
                {
                    var key = NormalizeWebPreferenceKey(hint.Text);
                    if (key.Length == 0 || !seen.Add(key))
                    {
                        continue;
                    }

                    candidates.Add(hint);
                    if (candidates.Count >= 16)
                    {
                        break;
                    }
                }

                if (candidates.Count >= 16)
                {
                    break;
                }
            }
        }

        var memoryNotes = MergeMemoryNoteNames(Array.Empty<string>(), linkedMemoryNotes);
        foreach (var noteName in memoryNotes.Take(4))
        {
            var read = _memoryNoteStore.Read(noteName);
            if (read is null || string.IsNullOrWhiteSpace(read.Content))
            {
                continue;
            }

            foreach (var hint in ExtractWebPreferenceHints(read.Content, fromMemoryNote: true))
            {
                var key = NormalizeWebPreferenceKey(hint.Text);
                if (key.Length == 0 || !seen.Add(key))
                {
                    continue;
                }

                candidates.Add(hint);
                if (candidates.Count >= 16)
                {
                    break;
                }
            }

            if (candidates.Count >= 16)
            {
                break;
            }
        }

        if (candidates.Count == 0)
        {
            return string.Empty;
        }

        var filtered = candidates
            .Where(item =>
            {
                return item.Category switch
                {
                    "source" => !hasSourceOverride,
                    "count" => !hasCountOverride,
                    "format" => !hasFormatOverride,
                    "tone" => !hasToneOverride,
                    "language" => !hasLanguageOverride,
                    _ => false
                };
            })
            .Select(item => item.Text)
            .Where(text => !string.IsNullOrWhiteSpace(text))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (filtered.Length == 0)
        {
            return string.Empty;
        }

        var lines = new List<string>(2);
        var charBudget = 160;
        var used = 0;
        foreach (var text in filtered)
        {
            if (lines.Count >= 2)
            {
                break;
            }

            var compact = Regex.Replace(text, @"\s+", " ").Trim();
            if (compact.Length == 0)
            {
                continue;
            }

            var line = $"- {compact}";
            var delta = line.Length + (lines.Count == 0 ? 0 : 1);
            if (used + delta > charBudget)
            {
                break;
            }

            lines.Add(line);
            used += delta;
        }

        return lines.Count == 0 ? string.Empty : string.Join('\n', lines);
    }

    private static IReadOnlyList<WebPreferenceHint> ExtractWebPreferenceHints(string text, bool fromMemoryNote)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return Array.Empty<WebPreferenceHint>();
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        var hints = new List<WebPreferenceHint>(8);
        foreach (var raw in lines.Take(120))
        {
            var line = (raw ?? string.Empty).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            line = Regex.Replace(line, @"^[-*•\d\.\)\s]+", string.Empty).Trim();
            if (line.Length < 4 || line.Length > 96)
            {
                continue;
            }

            if (fromMemoryNote
                && (line.StartsWith("created_utc", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("mode", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("conversation_id", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("conversation_title", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("provider", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("model", StringComparison.OrdinalIgnoreCase)
                    || line.StartsWith("#", StringComparison.Ordinal)))
            {
                continue;
            }

            if (!LooksLikeWebPreferenceLine(line, fromMemoryNote))
            {
                continue;
            }

            var category = ClassifyWebPreferenceCategory(line);
            if (category.Length == 0)
            {
                continue;
            }

            hints.Add(new WebPreferenceHint(category, line));
            if (hints.Count >= 8)
            {
                break;
            }
        }

        return hints;
    }

    private static bool LooksLikeWebPreferenceLine(string line, bool fromMemoryNote)
    {
        var lowered = (line ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return false;
        }

        if (lowered.Contains("http://", StringComparison.Ordinal)
            || lowered.Contains("https://", StringComparison.Ordinal))
        {
            return false;
        }

        if (ContainsAny(lowered, "가격", "시세", "주가", "배럴", "달러", "환율", "정확한 날짜", "대기압", "수치"))
        {
            return false;
        }

        if (!fromMemoryNote
            && !ContainsAny(lowered, "항상", "앞으로", "이제부터", "매번", "선호", "기억", "기본"))
        {
            return false;
        }

        return ContainsAny(
            lowered,
            "출처",
            "매체",
            "source",
            "site:",
            "형식",
            "포맷",
            "불릿",
            "번호",
            "목록",
            "리스트",
            "한줄",
            "줄바꿈",
            "간결",
            "짧게",
            "자세히",
            "말투",
            "존댓말",
            "반말",
            "한국어",
            "한글",
            "영어",
            "english",
            "korean",
            "cnn",
            "reuters",
            "bbc",
            "연합뉴스",
            "뉴시스",
            "kbs",
            "mbc",
            "sbs",
            "건수",
            "no.n"
        ) || RequestedCountRegex.IsMatch(lowered) || TopCountRegex.IsMatch(lowered);
    }

    private static string ClassifyWebPreferenceCategory(string line)
    {
        var lowered = (line ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return string.Empty;
        }

        if (ContainsAny(lowered, "출처", "매체", "source", "site:", "cnn", "reuters", "bbc", "연합뉴스", "뉴시스", "kbs", "mbc", "sbs"))
        {
            return "source";
        }

        if (ContainsAny(lowered, "형식", "포맷", "불릿", "번호", "목록", "리스트", "한줄", "줄바꿈", "markdown", "마크다운", "no.n"))
        {
            return "format";
        }

        if (ContainsAny(lowered, "간결", "짧게", "자세히", "길게", "말투", "존댓말", "반말", "톤"))
        {
            return "tone";
        }

        if (ContainsAny(lowered, "한국어", "한글", "영어", "english", "korean"))
        {
            return "language";
        }

        var hasCount = RequestedCountRegex.IsMatch(lowered)
            || TopCountRegex.IsMatch(lowered)
            || Regex.IsMatch(lowered, @"(?<!\d)\d{1,2}\s*(개|건)", RegexOptions.CultureInvariant);
        if (hasCount && ContainsAny(lowered, "뉴스", "news", "헤드라인", "목록", "리스트", "건수"))
        {
            return "count";
        }

        return string.Empty;
    }

    private static string NormalizeWebPreferenceKey(string text)
    {
        return Regex.Replace((text ?? string.Empty).Trim().ToLowerInvariant(), @"\s+", " ");
    }

    private static bool ShouldBlockWebMemoryHintByOverride(string input)
    {
        var lowered = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            lowered,
            "말고",
            "제외",
            "빼고",
            "아니고",
            "반대로",
            "다르게",
            "바꿔",
            "변경",
            "무시",
            "이번엔",
            "이번에는"
        );
    }

    private static bool LooksLikeWebFormatDirective(string input)
    {
        var lowered = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            lowered,
            "형식",
            "포맷",
            "불릿",
            "번호",
            "목록",
            "리스트",
            "한줄",
            "줄바꿈",
            "markdown",
            "마크다운",
            "no.n"
        );
    }

    private static bool LooksLikeWebToneDirective(string input)
    {
        var lowered = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            lowered,
            "간결",
            "짧게",
            "자세히",
            "길게",
            "말투",
            "존댓말",
            "반말",
            "톤"
        );
    }

    private static bool LooksLikeWebLanguageDirective(string input)
    {
        var lowered = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (lowered.Length == 0)
        {
            return false;
        }

        return ContainsAny(lowered, "한국어", "한글", "영어", "english", "korean");
    }

    private int ResolveWebDefaultCount(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (ContainsAny(normalized, "뉴스", "news", "헤드라인", "속보"))
        {
            return Math.Clamp(_config.WebDefaultNewsCount, 1, 20);
        }

        return Math.Clamp(_config.WebDefaultListCount, 1, 20);
    }

    private int ResolveGeminiWebAnswerMaxOutputTokens(string input)
    {
        var normalized = (input ?? string.Empty).Trim();
        var targetCount = HasExplicitRequestedCountInQuery(normalized)
            ? Math.Clamp(ResolveRequestedResultCountFromQuery(normalized), 1, 20)
            : ResolveWebDefaultCount(normalized);
        var tableMode = LooksLikeTableRenderRequest(normalized);
        var listMode = LooksLikeListOutputRequest(normalized);
        var comparisonMode = LooksLikeComparisonRequest(normalized);
        if (!tableMode && !listMode && !comparisonMode)
        {
            return 1024;
        }

        if (targetCount > 5 || (tableMode && normalized.Length >= 80))
        {
            return 1280;
        }

        return 1024;
    }

    private int ResolveGeminiUrlContextMaxOutputTokens(string input)
    {
        var normalized = (input ?? string.Empty).Trim();
        var targetCount = HasExplicitRequestedCountInQuery(normalized)
            ? Math.Clamp(ResolveRequestedResultCountFromQuery(normalized), 1, 20)
            : ResolveWebDefaultCount(normalized);
        var tableMode = LooksLikeTableRenderRequest(normalized);
        var listMode = LooksLikeListOutputRequest(normalized);
        var comparisonMode = LooksLikeComparisonRequest(normalized);
        if (!tableMode && !listMode && !comparisonMode)
        {
            return 2048;
        }

        if (targetCount > 5 || (tableMode && normalized.Length >= 80))
        {
            return 4096;
        }

        return 2048;
    }

    private static bool IsGeminiUrlContextFailureText(string text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return true;
        }

        return normalized.StartsWith("Gemini URL 참조 요청 실패:", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini URL 참조 응답 시간이 초과되었습니다.", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini URL 참조 호출 오류:", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini URL 참조 응답이 비어 있습니다.", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("429", StringComparison.OrdinalIgnoreCase)
               && normalized.Contains("Gemini", StringComparison.OrdinalIgnoreCase);
    }

    private string BuildGeminiUrlContextFailureNotice(string input, string failureText)
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var coreFailure = (failureText ?? string.Empty).Trim();
        return $"""
                요청하신 URL 참조 답변을 생성하지 못했습니다.
                원인: {coreFailure}
                안내: URL 접근 권한이나 본문 공개 상태를 확인한 뒤 다시 요청해 주세요.
                입력: {normalizedInput}
                """.Trim();
    }

    private static bool IsGeminiWebFailureText(string text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return true;
        }

        return normalized.StartsWith("Gemini 웹검색 요청 실패:", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini 웹검색 응답 시간이 초과되었습니다.", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini 웹검색 호출 오류:", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("Gemini 웹검색 응답이 비어 있습니다.", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("429", StringComparison.OrdinalIgnoreCase)
               && normalized.Contains("Gemini", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsGeminiWebTimeoutText(string text)
    {
        var normalized = (text ?? string.Empty).Trim();
        return normalized.StartsWith("Gemini 웹검색 응답 시간이 초과되었습니다.", StringComparison.OrdinalIgnoreCase);
    }

    private string BuildGeminiWebFailureNotice(string input, string failureText)
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var coreFailure = (failureText ?? string.Empty).Trim();
        var shortagePrefix = LooksLikeListOutputRequest(normalizedInput)
            ? "요청하신 목록을 생성하지 못했습니다."
            : "요청하신 최신 정보를 생성하지 못했습니다.";
        return $"""
                {shortagePrefix}
                원인: {coreFailure}
                안내: 잠시 후 다시 요청해 주세요.
                입력: {normalizedInput}
                """.Trim();
    }

    private static bool TryParseNeedWebDecisionJson(string? rawText, out bool needWeb, out string reason)
    {
        needWeb = false;
        reason = string.Empty;
        var text = (rawText ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return false;
        }

        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            return false;
        }

        var json = text[start..(end + 1)];
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (!TryGetPropertyIgnoreCase(root, "need_web", out var needWebElement)
                && !TryGetPropertyIgnoreCase(root, "needWeb", out needWebElement))
            {
                return false;
            }

            switch (needWebElement.ValueKind)
            {
                case JsonValueKind.True:
                    needWeb = true;
                    break;
                case JsonValueKind.False:
                    needWeb = false;
                    break;
                case JsonValueKind.String:
                    var normalizedToken = NormalizeWebSearchDecisionToken(needWebElement.GetString());
                    if (normalizedToken == "yes")
                    {
                        needWeb = true;
                    }
                    else if (normalizedToken == "no")
                    {
                        needWeb = false;
                    }
                    else
                    {
                        return false;
                    }
                    break;
                default:
                    return false;
            }

            if (TryGetPropertyIgnoreCase(root, "reason", out var reasonElement)
                && reasonElement.ValueKind == JsonValueKind.String)
            {
                reason = (reasonElement.GetString() ?? string.Empty).Trim();
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task<SearchRequirementDecision> DecideWebSearchRequirementAsync(
        string input,
        CancellationToken cancellationToken
    )
    {
        var normalized = (input ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return new SearchRequirementDecision(false, "llm:false:empty_input", string.Empty, string.Empty);
        }

        if (_config.EnableFastWebPipeline)
        {
            var heuristicNeedWeb = LooksLikeExplicitWebLookupQuestion(normalized) || LooksLikeRealtimeQuestion(normalized);
            return new SearchRequirementDecision(
                heuristicNeedWeb,
                heuristicNeedWeb
                    ? (LooksLikeExplicitWebLookupQuestion(normalized) ? "fast:true:explicit_web" : "fast:true:heuristic")
                    : "fast:false:heuristic",
                ExtractSourceFocusHintFromInput(normalized),
                ExtractSourceDomainHintFromInput(normalized)
            );
        }

        var provider = _llmRouter.HasGeminiApiKey()
            ? "gemini"
            : string.Empty;
        if (provider.Length == 0)
        {
            var fallbackDecision = LooksLikeExplicitWebLookupQuestion(normalized) || LooksLikeRealtimeQuestion(normalized);
            return new SearchRequirementDecision(
                fallbackDecision,
                fallbackDecision ? "fallback:true:no_llm_key" : "fallback:false:no_llm_key",
                ExtractSourceFocusHintFromInput(normalized),
                ExtractSourceDomainHintFromInput(normalized)
            );
        }

        var model = ResolveSearchLlmModel();
        var prompt = $"""
                      사용자의 입력을 보고 웹 검색 필요 여부와 소스 제약 의도를 JSON으로 판단하세요.
                      기준:
                      - 최신성/실시간성(뉴스, 오늘 일정, 시세, 최근 변경, 현재 상태)이 중요하면 needWeb=YES
                      - 일반 지식/설명/창작/코딩처럼 최신 웹 근거가 필수 아님이면 needWeb=NO
                      - 특정 매체/기관/브랜드의 정보만 원하는 의도가 보이면 sourceFocus에 그 명칭을 넣으세요.
                      - sourceFocus가 있고 공식 도메인을 신뢰성 있게 유추 가능하면 sourceDomain에 도메인만 넣으세요. (예: cnn.com)

                      출력 규칙:
                      - 반드시 JSON 한 줄만 출력
                      - 스키마 키: needWeb, sourceFocus, sourceDomain
                      - 예시 형식: needWeb=YES, sourceFocus=CNN, sourceDomain=cnn.com
                      - sourceFocus/sourceDomain이 없으면 빈 문자열

                      사용자 입력:
                      {normalized}
                      """;
        var decision = await GenerateByProviderSafeAsync(
            provider,
            model,
            prompt,
            cancellationToken,
            maxOutputTokens: 96
        );
        if (TryParseSearchRequirementDecisionJson(
                decision.Text,
                out var parsedNeedWeb,
                out var parsedSourceFocus,
                out var parsedSourceDomain))
        {
            return new SearchRequirementDecision(
                parsedNeedWeb,
                parsedNeedWeb ? $"llm:true:{provider}:{decision.Model}" : $"llm:false:{provider}:{decision.Model}",
                parsedSourceFocus,
                parsedSourceDomain
            );
        }

        var decisionToken = NormalizeWebSearchDecisionToken(decision.Text);
        if (decisionToken == "no")
        {
            return new SearchRequirementDecision(
                false,
                $"llm:false:{provider}:{decision.Model}",
                ExtractSourceFocusHintFromInput(normalized),
                ExtractSourceDomainHintFromInput(normalized)
            );
        }

        if (decisionToken == "yes")
        {
            return new SearchRequirementDecision(
                true,
                $"llm:true:{provider}:{decision.Model}",
                ExtractSourceFocusHintFromInput(normalized),
                ExtractSourceDomainHintFromInput(normalized)
            );
        }

        var fallback = LooksLikeExplicitWebLookupQuestion(normalized) || LooksLikeRealtimeQuestion(normalized);
        return new SearchRequirementDecision(
            fallback,
            fallback
                ? $"fallback:true:unparsed:{provider}:{decision.Model}"
                : $"fallback:false:unparsed:{provider}:{decision.Model}",
            ExtractSourceFocusHintFromInput(normalized),
            ExtractSourceDomainHintFromInput(normalized)
        );
    }

    private string ResolveSearchLlmModel()
    {
        var configured = NormalizeModelSelection(_config.GeminiSearchModel);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured!;
        }

        return _config.GeminiModel;
    }

    private string ResolveUrlContextLlmModel()
    {
        var configured = NormalizeModelSelection(_config.GeminiModel);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured!;
        }

        return "gemini-3-flash-preview";
    }

    private bool ShouldUseGeminiWebComposer(
        string input,
        IReadOnlyList<SearchCitationReference>? citations,
        string requestedProvider
    )
    {
        if (!_llmRouter.HasGeminiApiKey())
        {
            return false;
        }

        if (requestedProvider.Equals("gemini", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (citations == null || citations.Count == 0)
        {
            return false;
        }

        return LooksLikeListOutputRequest(input);
    }

    private static bool TryParseSearchRequirementDecisionJson(
        string? rawText,
        out bool needWeb,
        out string sourceFocus,
        out string sourceDomain
    )
    {
        needWeb = false;
        sourceFocus = string.Empty;
        sourceDomain = string.Empty;
        var text = (rawText ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return false;
        }

        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            return false;
        }

        var json = text[start..(end + 1)];
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var needToken = string.Empty;
            if (TryGetPropertyIgnoreCase(root, "needWeb", out var needWebElement))
            {
                needToken = (needWebElement.GetString() ?? string.Empty).Trim();
            }

            var normalizedNeed = NormalizeWebSearchDecisionToken(needToken);
            if (normalizedNeed == "yes")
            {
                needWeb = true;
            }
            else if (normalizedNeed == "no")
            {
                needWeb = false;
            }
            else
            {
                return false;
            }

            if (TryGetPropertyIgnoreCase(root, "sourceFocus", out var sourceFocusElement)
                && sourceFocusElement.ValueKind == JsonValueKind.String)
            {
                sourceFocus = (sourceFocusElement.GetString() ?? string.Empty).Trim();
            }

            if (TryGetPropertyIgnoreCase(root, "sourceDomain", out var sourceDomainElement)
                && sourceDomainElement.ValueKind == JsonValueKind.String)
            {
                sourceDomain = NormalizeSourceDomainHint(sourceDomainElement.GetString());
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryGetPropertyIgnoreCase(JsonElement element, string propertyName, out JsonElement value)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            value = default;
            return false;
        }

        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }

    private static string ExtractSourceFocusHintFromInput(string input)
    {
        var normalized = (input ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var match = Regex.Match(
            normalized,
            @"(?<focus>[A-Za-z0-9가-힣][A-Za-z0-9가-힣\.\-]{1,40})\s*(?:의\s*)?(?:주요\s*)?뉴스",
            RegexOptions.CultureInvariant
        );
        if (!match.Success)
        {
            return string.Empty;
        }

        var focus = (match.Groups["focus"].Value ?? string.Empty).Trim();
        if (focus.Length < 2)
        {
            return string.Empty;
        }

        var loweredFocus = focus.ToLowerInvariant();
        if (loweredFocus is "오늘"
            or "어제"
            or "최근"
            or "최신"
            or "방금"
            or "실시간"
            or "주요"
            or "뉴스"
            or "헤드라인"
            or "속보"
            or "latest"
            or "recent"
            or "today"
            or "breaking"
            or "top")
        {
            return string.Empty;
        }

        return focus;
    }

    private static string ExtractSourceDomainHintFromInput(string input)
    {
        var normalized = (input ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var explicitSite = Regex.Match(
            normalized,
            @"site\s*:\s*(?<domain>[A-Za-z0-9][A-Za-z0-9\.\-]*\.[A-Za-z]{2,})",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
        );
        if (explicitSite.Success)
        {
            return NormalizeSourceDomainHint(explicitSite.Groups["domain"].Value);
        }

        return string.Empty;
    }

    private static string NormalizeSourceDomainHint(string? domain)
    {
        var normalized = (domain ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.StartsWith("http://", StringComparison.Ordinal))
        {
            normalized = normalized["http://".Length..];
        }
        else if (normalized.StartsWith("https://", StringComparison.Ordinal))
        {
            normalized = normalized["https://".Length..];
        }

        normalized = normalized.Trim('/');
        if (normalized.StartsWith("www.", StringComparison.Ordinal))
        {
            normalized = normalized[4..];
        }

        return Regex.IsMatch(normalized, @"^[a-z0-9][a-z0-9\.-]*\.[a-z]{2,}$", RegexOptions.CultureInvariant)
            ? normalized
            : string.Empty;
    }

    private static string BuildEffectiveSearchQuery(string query, SearchRequirementDecision decision)
    {
        var baseQuery = (query ?? string.Empty).Trim();
        if (baseQuery.Length == 0)
        {
            return baseQuery;
        }

        var sourceFocus = (decision.SourceFocus ?? string.Empty).Trim();
        if (sourceFocus.Length == 0)
        {
            if (LooksLikeListOutputRequest(baseQuery))
            {
                var lowered = baseQuery.ToLowerInvariant();
                if (!ContainsAny(lowered, "latest", "breaking", "headlines", "top stories")
                    && ContainsAny(lowered, "뉴스", "news", "헤드라인", "속보"))
                {
                    return $"{baseQuery} latest breaking headlines";
                }
            }

            return baseQuery;
        }

        var builder = new StringBuilder(baseQuery);
        if (!baseQuery.Contains(sourceFocus, StringComparison.OrdinalIgnoreCase))
        {
            builder.Append(' ').Append(sourceFocus);
        }

        var sourceDomain = NormalizeSourceDomainHint(decision.SourceDomain);
        if (sourceDomain.Length == 0)
        {
            sourceDomain = ResolveSourceDomainFromQueryOrFocus(baseQuery, sourceFocus);
        }
        if (sourceDomain.Length > 0
            && !baseQuery.Contains(sourceDomain, StringComparison.OrdinalIgnoreCase))
        {
            builder.Append(' ').Append(sourceDomain);
        }

        if (LooksLikeListOutputRequest(baseQuery))
        {
            var lowered = baseQuery.ToLowerInvariant();
            if (!ContainsAny(lowered, "official", "공식", "homepage", "top headlines", "top stories"))
            {
                builder.Append(' ').Append(sourceFocus).Append(" official top headlines");
            }
        }

        return builder.ToString().Trim();
    }

    private static string NormalizeWebSearchDecisionToken(string? decisionText)
    {
        var normalized = (decisionText ?? string.Empty).Trim().ToUpperInvariant();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        if (normalized.StartsWith("YES", StringComparison.Ordinal)
            || normalized == "Y")
        {
            return "yes";
        }

        if (normalized.StartsWith("NO", StringComparison.Ordinal)
            || normalized == "N")
        {
            return "no";
        }

        var compact = Regex.Replace(normalized, @"[^A-Z가-힣]", string.Empty);
        if (compact.Contains("YES", StringComparison.Ordinal))
        {
            return "yes";
        }

        if (compact.Contains("NO", StringComparison.Ordinal))
        {
            return "no";
        }

        if (compact.Contains("필요", StringComparison.Ordinal) && !compact.Contains("불필요", StringComparison.Ordinal))
        {
            return "yes";
        }

        if (compact.Contains("불필요", StringComparison.Ordinal))
        {
            return "no";
        }

        return string.Empty;
    }

    private static bool LooksLikeRealtimeQuestion(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            normalized,
            "최신",
            "최근",
            "오늘",
            "어제",
            "방금",
            "실시간",
            "지금",
            "뉴스",
            "속보",
            "업데이트",
            "변경점",
            "릴리즈",
            "출시",
            "현재",
            "latest",
            "recent",
            "today",
            "yesterday",
            "now",
            "news",
            "update",
            "release",
            "current"
        );
    }

    private static bool LooksLikeExplicitWebLookupQuestion(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return ContainsAny(
                normalized,
                "검색해서",
                "알려줘",
                "말해줘",
                "검색해줘",
                "검색해 줘",
                "검색해봐",
                "찾아봐",
                "찾아봐줘",
                "알아봐",
                "알아봐줘",
                "웹에서",
                "인터넷에서",
                "search for",
                "look up",
                "lookup"
            )
            || Regex.IsMatch(
                normalized,
                @"\b(?:search|lookup)\b",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
            );
    }

    private static bool LooksLikeClearlyNonWebQuestion(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0
            || LooksLikeRealtimeQuestion(normalized)
            || LooksLikeExplicitWebLookupQuestion(normalized))
        {
            return false;
        }

        if (ContainsAny(
                normalized,
                "번역",
                "translate",
                "영작",
                "영문",
                "맞춤법",
                "교정",
                "다듬",
                "rewrite",
                "rephrase"))
        {
            return true;
        }

        if (ContainsAny(normalized, "코드", "code")
            && ContainsAny(normalized, "설명", "해석", "리뷰", "explain", "review"))
        {
            return true;
        }

        if (ContainsAny(normalized, "요약", "summary", "summarize", "정리"))
        {
            return normalized.Contains('\n')
                || normalized.Contains("```", StringComparison.Ordinal)
                || normalized.Contains("다음", StringComparison.Ordinal)
                || normalized.Contains("\"", StringComparison.Ordinal);
        }

        return false;
    }

    private static bool LooksLikeComparisonRequest(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            normalized,
            "비교",
            "차이",
            "대비",
            "vs",
            "compare",
            "difference",
            "국가별",
            "유형별",
            "카테고리별"
        );
    }

    private static double ResolveForcedMemoryMinScore(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return 0.45d;
        }

        if (LooksLikeRealtimeQuestion(normalized))
        {
            return 0.3d;
        }

        if (ContainsAny(normalized, "비교", "차이", "요약", "정리", "compare", "difference", "summary"))
        {
            return 0.5d;
        }

        return 0.45d;
    }

    private static string ResolveSearchFreshnessForQuery(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (ContainsAny(normalized, "오늘", "어제", "방금", "실시간", "today", "yesterday", "breaking"))
        {
            return "day";
        }

        if (ContainsAny(normalized, "이번달", "한달", "month", "monthly"))
        {
            return "month";
        }

        if (ContainsAny(normalized, "올해", "연간", "year", "yearly"))
        {
            return "year";
        }

        return "week";
    }

    private static int ResolveRequestedResultCountFromQuery(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        var defaultCount = ContainsAny(normalized, "뉴스", "news", "헤드라인", "속보", "브리핑")
            ? 10
            : 5;
        if (normalized.Length == 0)
        {
            return defaultCount;
        }

        var direct = RequestedCountRegex.Match(normalized);
        if (direct.Success
            && int.TryParse(direct.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var directParsed))
        {
            return Math.Clamp(directParsed, 1, 10);
        }

        var top = TopCountRegex.Match(normalized);
        if (top.Success
            && int.TryParse(top.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var topParsed))
        {
            return Math.Clamp(topParsed, 1, 10);
        }

        return defaultCount;
    }

    private static bool HasExplicitRequestedCountInQuery(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return RequestedCountRegex.IsMatch(normalized) || TopCountRegex.IsMatch(normalized);
    }

    private static bool CanUseDeterministicListFastPath(
        string input,
        IReadOnlyList<SearchCitationReference>? citations
    )
    {
        if (!HasExplicitRequestedCountInQuery(input))
        {
            return false;
        }

        if (citations == null || citations.Count == 0)
        {
            return false;
        }

        var targetCount = Math.Clamp(ResolveRequestedResultCountFromQuery(input), 1, 10);
        var normalized = citations
            .Select(item =>
            {
                if (!TryNormalizeDisplaySourceUrl(item.Url, out var sourceUrl))
                {
                    return null;
                }

                return item with { Url = sourceUrl };
            })
            .Where(item => item is not null)
            .Cast<SearchCitationReference>()
            .ToArray();
        if (normalized.Length < targetCount)
        {
            return false;
        }

        var deduplicated = DeduplicateCitationsForList(normalized);
        if (deduplicated.Length < targetCount)
        {
            return false;
        }

        var qualityFiltered = deduplicated
            .Where(item => !IsLowQualityCitationForList(item))
            .ToArray();
        return qualityFiltered.Length >= targetCount;
    }
}
