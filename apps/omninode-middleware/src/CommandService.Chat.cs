using System.Diagnostics;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    public Task<ConversationChatResult> ChatSingleWithStateAsync(
        ChatRequest request,
        CancellationToken cancellationToken,
        Action<ChatStreamUpdate>? streamCallback = null
    )
    {
        return ChatSingleWithStateCoreAsync(request, cancellationToken, streamCallback);
    }

    public Task<ConversationChatResult> ChatOrchestrationWithStateAsync(
        ChatRequest request,
        CancellationToken cancellationToken
    )
    {
        return ChatOrchestrationWithStateCoreAsync(request, cancellationToken);
    }

    public Task<ConversationMultiResult> ChatMultiWithStateAsync(
        MultiChatRequest request,
        CancellationToken cancellationToken
    )
    {
        return ChatMultiWithStateCoreAsync(request, cancellationToken);
    }

    public Task<LlmSingleChatResult> ChatSingleAsync(
        string input,
        string provider,
        string? model,
        string source,
        CancellationToken cancellationToken,
        int? maxOutputTokens = null
    )
    {
        return ChatSingleCoreAsync(input, provider, model, source, cancellationToken, maxOutputTokens);
    }

    public Task<LlmOrchestrationResult> ChatOrchestrationAsync(
        string input,
        string source,
        string? provider,
        string? model,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
        string? codexModel,
        IReadOnlyList<InputAttachment>? attachments,
        CancellationToken cancellationToken
    )
    {
        return ChatOrchestrationCoreAsync(
            input,
            source,
            provider,
            model,
            groqModel,
            geminiModel,
            copilotModel,
            cerebrasModel,
            codexModel,
            attachments,
            cancellationToken
        );
    }

    public Task<LlmMultiChatResult> ChatMultiAsync(
        string input,
        string source,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
        string? summaryProvider,
        string? codexModel,
        IReadOnlyList<InputAttachment>? attachments,
        CancellationToken cancellationToken
    )
    {
        return ChatMultiCoreAsync(
            input,
            source,
            groqModel,
            geminiModel,
            copilotModel,
            cerebrasModel,
            summaryProvider,
            codexModel,
            attachments,
            cancellationToken
        );
    }

    private async Task<ConversationChatResult> ChatSingleWithStateCoreAsync(
        ChatRequest request,
        CancellationToken cancellationToken,
        Action<ChatStreamUpdate>? streamCallback = null
    )
    {
        var session = PrepareSessionContext(
            request.Scope,
            request.Mode,
            request.ConversationId,
            request.ConversationTitle,
            request.Project,
            request.Category,
            request.Tags,
            request.LinkedMemoryNotes,
            request.Source
        );
        var thread = session.Thread;
        var rawInput = (request.Input ?? string.Empty).Trim();
        var localUsageReply = await TryBuildInChatCopilotUsageResponseAsync(rawInput, request.Source, cancellationToken);
        if (!string.IsNullOrWhiteSpace(localUsageReply))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, "local:copilot_usage");
            _conversationStore.AppendMessage(thread.Id, "assistant", localUsageReply, "local:copilot_usage");
            ScheduleConversationMaintenance(
                thread.Id,
                "chat-single",
                "local",
                "copilot_usage"
            );

            var localUpdated = _conversationStore.Get(thread.Id) ?? thread;
            return new ConversationChatResult(
                "single",
                localUpdated.Id,
                "local",
                "copilot_usage",
                localUsageReply,
                "local:copilot_usage",
                localUpdated,
                null,
                null
            );
        }

        var requestedProvider = NormalizeProvider(request.Provider, allowAuto: true);
        if (requestedProvider == "auto")
        {
            requestedProvider = await ResolveAutoProviderAsync(cancellationToken);
            if (requestedProvider == "none")
            {
                requestedProvider = "groq";
            }
        }
        var resolvedModel = ResolveModel(requestedProvider, request.Model);
        var resolvedWebUrls = ResolveWebUrls(rawInput, request.WebUrls, request.WebSearchEnabled);
        if (resolvedWebUrls.Count > 0 && _llmRouter.HasGeminiApiKey())
        {
            var memoryHint = BuildSafeWebMemoryPreferenceHint(
                session.SessionId,
                rawInput,
                session.LinkedMemoryNotes
            );
            var urlResult = await GenerateGeminiUrlContextAnswerDetailedAsync(
                rawInput,
                resolvedWebUrls,
                memoryHint,
                allowMarkdownTable: true,
                enforceTelegramOutputStyle: false,
                streamCallback,
                session.Scope,
                session.Mode,
                thread.Id,
                "heuristic_url_context",
                0,
                cancellationToken
            );
            var urlText = urlResult.Response.Text;
            var assistantMeta = "gemini-url-single";
            var urlCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "chat-single-url-context",
                urlResult.Citations,
                ("text", urlText)
            );
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"{requestedProvider}:{request.Model ?? "-"}");
            _conversationStore.AppendMessage(thread.Id, "assistant", urlText, assistantMeta);
            ScheduleConversationMaintenance(
                thread.Id,
                $"{session.Scope}-{session.Mode}",
                urlResult.Response.Provider,
                urlResult.Response.Model
            );

            var updatedUrl = _conversationStore.Get(thread.Id) ?? thread;
            return new ConversationChatResult(
                "single",
                updatedUrl.Id,
                urlResult.Response.Provider,
                urlResult.Response.Model,
                urlText,
                assistantMeta,
                updatedUrl,
                null,
                null,
                urlResult.Citations,
                urlCitationBundle.Mappings,
                urlCitationBundle.Validation,
                0,
                0,
                "-",
                urlResult.Latency
            );
        }

        if (request.WebSearchEnabled)
        {
            var decisionStopwatch = Stopwatch.StartNew();
            var decisionPath = "llm";
            var shouldUseGeminiWeb = false;
            var selfDecideNeedWeb = false;

            if (LooksLikeExplicitWebLookupQuestion(rawInput))
            {
                decisionPath = "heuristic_explicit_web";
                shouldUseGeminiWeb = true;
            }
            else if (LooksLikeRealtimeQuestion(rawInput))
            {
                decisionPath = "heuristic_web";
                shouldUseGeminiWeb = true;
            }
            else if (LooksLikeClearlyNonWebQuestion(rawInput))
            {
                decisionPath = "heuristic_no_web";
            }
            else
            {
                var webDecision = await DecideNeedWebBySelectedProviderAsync(
                    rawInput,
                    requestedProvider,
                    resolvedModel,
                    cancellationToken
                );
                var shouldFallbackToGeminiWeb = !webDecision.DecisionSucceeded && LooksLikeRealtimeQuestion(rawInput);
                shouldUseGeminiWeb = webDecision.NeedWeb || shouldFallbackToGeminiWeb;
                selfDecideNeedWeb = shouldFallbackToGeminiWeb;
            }

            var decisionMs = Math.Max(0L, decisionStopwatch.ElapsedMilliseconds);
            if (shouldUseGeminiWeb)
            {
                var memoryHint = BuildSafeWebMemoryPreferenceHint(
                    session.SessionId,
                    rawInput,
                    session.LinkedMemoryNotes
                );
                var webResult = await ComposeGroundedWebAnswerWithFallbackAsync(
                    rawInput,
                    memoryHint,
                    selfDecideNeedWeb,
                    allowMarkdownTable: true,
                    enforceTelegramOutputStyle: false,
                    streamCallback,
                    session.Scope,
                    session.Mode,
                    thread.Id,
                    decisionPath,
                    decisionMs,
                    request.Source,
                    cancellationToken
                );
                var webText = webResult.Response.Text;
                var assistantMeta = webResult.Route;
                var webCitationBundle = BuildAndLogCitationMappings(
                    request.Source,
                    assistantMeta,
                    webResult.Citations,
                    ("text", webText)
                );
                _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"{requestedProvider}:{request.Model ?? "-"}");
                _conversationStore.AppendMessage(thread.Id, "assistant", webText, assistantMeta);
                ScheduleConversationMaintenance(
                    thread.Id,
                    $"{session.Scope}-{session.Mode}",
                    webResult.Response.Provider,
                    webResult.Response.Model
                );

                var updatedWeb = _conversationStore.Get(thread.Id) ?? thread;
                return new ConversationChatResult(
                    "single",
                    updatedWeb.Id,
                    webResult.Response.Provider,
                    webResult.Response.Model,
                    webText,
                    assistantMeta,
                    updatedWeb,
                    null,
                    webResult.GuardFailure,
                    webResult.Citations,
                    webCitationBundle.Mappings,
                    webCitationBundle.Validation,
                    0,
                    0,
                    "-",
                    webResult.Latency
                );
            }
        }

        using var singleRequestCts = requestedProvider.Equals("copilot", StringComparison.OrdinalIgnoreCase)
            ? null
            : CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var singleRequestToken = cancellationToken;
        if (singleRequestCts != null)
        {
            singleRequestCts.CancelAfter(TimeSpan.FromSeconds(17));
            singleRequestToken = singleRequestCts.Token;
        }

        var preparedInput = await PrepareInputForProviderAsync(
            rawInput,
            requestedProvider,
            resolvedModel,
            request.Attachments,
            request.WebUrls,
            false,
            true,
            singleRequestToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(preparedInput.UnsupportedMessage))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"{requestedProvider}:{request.Model ?? "-"}");
            _conversationStore.AppendMessage(thread.Id, "assistant", preparedInput.UnsupportedMessage, $"{requestedProvider}:{resolvedModel}");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "chat-single-unsupported",
                preparedInput.Citations,
                ("text", preparedInput.UnsupportedMessage)
            );
            return new ConversationChatResult(
                "single",
                blockedView.Id,
                requestedProvider,
                resolvedModel,
                preparedInput.UnsupportedMessage,
                string.Empty,
                blockedView,
                null,
                preparedInput.GuardFailure,
                preparedInput.Citations,
                blockedCitationBundle.Mappings,
                blockedCitationBundle.Validation,
                preparedInput.RetryAttempt,
                preparedInput.RetryMaxAttempts,
                preparedInput.RetryStopReason
            );
        }

        var singleMaxOutputTokens = ResolveSingleChatMaxOutputTokens(rawInput);
        var effectiveSingleToken = singleRequestToken;
        var singleGenerationProvider = requestedProvider;
        var singleGenerationModel = resolvedModel;

        async Task<LlmSingleChatResult> GenerateSingleAsync(string prompt, CancellationToken token)
        {
            return singleGenerationProvider == "groq"
                ? await ExecuteGroqSingleChainAsync(
                    prompt,
                    singleGenerationModel,
                    token,
                    singleMaxOutputTokens
                )
                : await ChatSingleAsync(
                    prompt,
                    singleGenerationProvider,
                    singleGenerationModel,
                    request.Source,
                    token,
                    singleMaxOutputTokens
                );
        }

        var contextualInput = BuildContextualInput(session.SessionId, preparedInput.Text, session.LinkedMemoryNotes);
        LlmSingleChatResult generated;
        try
        {
            generated = await GenerateSingleAsync(contextualInput, effectiveSingleToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            generated = new LlmSingleChatResult(
                requestedProvider,
                resolvedModel,
                $"{requestedProvider} 응답 시간이 초과되었습니다."
            );
        }

        if (!_config.EnableFastWebPipeline && ShouldRetrySingleChatWithoutHistory(rawInput, generated.Text))
        {
            var historyBypassInput = BuildHistoryBypassInput(preparedInput.Text);
            var recovered = await GenerateSingleAsync(historyBypassInput, effectiveSingleToken);
            if (!string.IsNullOrWhiteSpace(recovered.Text))
            {
                var recoveredStillDrift = ShouldRetrySingleChatWithoutHistory(rawInput, recovered.Text);
                _auditLogger.Log(
                    request.Source,
                    "chat_single_history_recovery",
                    recoveredStillDrift ? "skip" : "ok",
                    $"provider={requestedProvider} model={resolvedModel} recoveredStillDrift={(recoveredStillDrift ? "true" : "false")}"
                );
                if (!recoveredStillDrift)
                {
                    generated = recovered;
                }
            }
            else
            {
                _auditLogger.Log(
                    request.Source,
                    "chat_single_history_recovery",
                    "skip",
                    $"provider={requestedProvider} model={resolvedModel} empty_recovered_text=true"
                );
            }
        }

        var citationBundle = BuildAndLogCitationMappings(
            request.Source,
            "chat-single",
            preparedInput.Citations,
            ("text", generated.Text)
        );
        var effectiveGuardFailure = preparedInput.GuardFailure;
        var responseText = ApplyListCountFallback(rawInput, generated.Text, preparedInput.Citations);

        _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"{requestedProvider}:{request.Model ?? "-"}");
        _conversationStore.AppendMessage(thread.Id, "assistant", responseText, $"{generated.Provider}:{generated.Model}");
        ScheduleConversationMaintenance(
            thread.Id,
            $"{session.Scope}-{session.Mode}",
            generated.Provider,
            generated.Model
        );

        var updated = _conversationStore.Get(thread.Id) ?? thread;
        return new ConversationChatResult(
            "single",
            updated.Id,
            generated.Provider,
            generated.Model,
            responseText,
            string.Empty,
            updated,
            null,
            effectiveGuardFailure,
            preparedInput.Citations,
            citationBundle.Mappings,
            citationBundle.Validation,
            preparedInput.RetryAttempt,
            preparedInput.RetryMaxAttempts,
            preparedInput.RetryStopReason
        );
    }

    private static bool ShouldRetrySingleChatWithoutHistory(string input, string output)
    {
        var normalizedInput = (input ?? string.Empty).Trim().ToLowerInvariant();
        var normalizedOutput = (output ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedInput.Length == 0 || normalizedOutput.Length == 0)
        {
            return false;
        }

        var isNewsRequest = ContainsAny(normalizedInput, "뉴스", "news", "헤드라인", "속보", "브리핑");
        if (isNewsRequest)
        {
            return false;
        }

        var looksLikeNewsAnswer = ContainsAny(
            normalizedOutput,
            "요청하신 소식",
            "주요 뉴스",
            "뉴스 10건",
            "뉴스 5건",
            "오늘 주요 뉴스",
            "no.1 제목"
        );
        if (!looksLikeNewsAnswer)
        {
            return false;
        }

        var asksLlmPricing = ContainsAny(
            normalizedInput,
            "llm",
            "large language model",
            "언어 모델",
            "컨텍스트",
            "context window",
            "토큰",
            "api",
            "비용",
            "가격",
            "요금"
        );
        var hasLlmPricingSignalsInOutput = ContainsAny(
            normalizedOutput,
            "llm",
            "언어 모델",
            "컨텍스트",
            "context window",
            "토큰",
            "api",
            "비용",
            "가격",
            "요금"
        );
        if (asksLlmPricing && !hasLlmPricingSignalsInOutput)
        {
            return true;
        }

        return true;
    }

    private static int ResolveSingleChatMaxOutputTokens(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return 1600;
        }

        if (LooksLikeListOutputRequest(normalized))
        {
            return 1100;
        }

        if (ContainsAny(normalized, "요약", "정리", "summary", "compare", "비교"))
        {
            return 900;
        }

        return 1200;
    }

    private static string BuildHistoryBypassInput(string preparedInput)
    {
        var normalized = (preparedInput ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        return $"""
                [중요]
                아래 새 요청을 최우선으로 처리하세요.
                이전 대화의 형식을 관성으로 따라가지 말고, 새 요청 주제에만 답변하세요.

                [새 요청]
                {normalized}
                """;
    }

    private async Task<ConversationChatResult> ChatOrchestrationWithStateCoreAsync(
        ChatRequest request,
        CancellationToken cancellationToken
    )
    {
        var session = PrepareSessionContext(
            request.Scope,
            request.Mode,
            request.ConversationId,
            request.ConversationTitle,
            request.Project,
            request.Category,
            request.Tags,
            request.LinkedMemoryNotes,
            request.Source
        );
        var thread = session.Thread;
        var rawInput = (request.Input ?? string.Empty).Trim();
        var localUsageReply = await TryBuildInChatCopilotUsageResponseAsync(rawInput, request.Source, cancellationToken);
        if (!string.IsNullOrWhiteSpace(localUsageReply))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, "local:copilot_usage");
            _conversationStore.AppendMessage(thread.Id, "assistant", localUsageReply, "local:copilot_usage");
            await EnsureConversationTitleFromFirstTurnAsync(
                thread.Id,
                "local",
                "copilot_usage",
                cancellationToken
            );

            var localUpdated = _conversationStore.Get(thread.Id) ?? thread;
            return new ConversationChatResult(
                "orchestration",
                localUpdated.Id,
                "local",
                "copilot_usage",
                localUsageReply,
                "local:copilot_usage",
                localUpdated,
                null,
                null
            );
        }

        var basePrepared = await PrepareSharedInputAsync(
            rawInput,
            request.Attachments,
            request.WebUrls,
            request.WebSearchEnabled,
            cancellationToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(basePrepared.UnsupportedMessage))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"orchestration:{request.Provider ?? "auto"}");
            _conversationStore.AppendMessage(thread.Id, "assistant", basePrepared.UnsupportedMessage, "orchestration:unsupported");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "chat-orchestration-unsupported",
                basePrepared.Citations,
                ("text", basePrepared.UnsupportedMessage)
            );
            return new ConversationChatResult(
                "orchestration",
                blockedView.Id,
                request.Provider ?? "auto",
                request.Model ?? "-",
                basePrepared.UnsupportedMessage,
                "orchestration:unsupported",
                blockedView,
                null,
                basePrepared.GuardFailure,
                basePrepared.Citations,
                blockedCitationBundle.Mappings,
                blockedCitationBundle.Validation,
                basePrepared.RetryAttempt,
                basePrepared.RetryMaxAttempts,
                basePrepared.RetryStopReason
            );
        }
        var contextualInput = BuildContextualInput(session.SessionId, basePrepared.Text, session.LinkedMemoryNotes);

        var generated = await ChatOrchestrationAsync(
            contextualInput,
            request.Source,
            request.Provider,
            request.Model,
            request.GroqModel,
            request.GeminiModel,
            request.CopilotModel,
            request.CerebrasModel,
            request.CodexModel,
            request.Attachments,
            cancellationToken
        );
        var citationBundle = BuildAndLogCitationMappings(
            request.Source,
            "chat-orchestration",
            basePrepared.Citations,
            ("text", generated.Text)
        );
        var effectiveGuardFailure = basePrepared.GuardFailure;
        var responseText = ApplyListCountFallback(rawInput, generated.Text, basePrepared.Citations);

        _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"orchestration:{request.Provider ?? "auto"}");
        _conversationStore.AppendMessage(thread.Id, "assistant", responseText, generated.Route);
        await EnsureConversationTitleFromFirstTurnAsync(
            thread.Id,
            request.Provider ?? "auto",
            request.Model ?? string.Empty,
            cancellationToken
        );

        var note = await MaybeCompressConversationAsync(
            thread.Id,
            $"{session.Scope}-{session.Mode}",
            request.Provider ?? "auto",
            request.Model ?? string.Empty,
            cancellationToken
        );

        var updated = _conversationStore.Get(thread.Id) ?? thread;
        return new ConversationChatResult(
            "orchestration",
            updated.Id,
            request.Provider ?? "auto",
            request.Model ?? "-",
            responseText,
            generated.Route,
            updated,
            note,
            effectiveGuardFailure,
            basePrepared.Citations,
            citationBundle.Mappings,
            citationBundle.Validation,
            basePrepared.RetryAttempt,
            basePrepared.RetryMaxAttempts,
            basePrepared.RetryStopReason
        );
    }

    private async Task<ConversationMultiResult> ChatMultiWithStateCoreAsync(
        MultiChatRequest request,
        CancellationToken cancellationToken
    )
    {
        var session = PrepareSessionContext(
            request.Scope,
            request.Mode,
            request.ConversationId,
            request.ConversationTitle,
            request.Project,
            request.Category,
            request.Tags,
            request.LinkedMemoryNotes,
            request.Source
        );
        var thread = session.Thread;
        var rawInput = (request.Input ?? string.Empty).Trim();
        var localGroqModel = IsDisabledModelSelection(request.GroqModel)
            ? "none"
            : string.IsNullOrWhiteSpace(request.GroqModel)
                ? _llmRouter.GetSelectedGroqModel()
                : request.GroqModel.Trim();
        var localGeminiModel = IsDisabledModelSelection(request.GeminiModel)
            ? "none"
            : NormalizeModelSelection(request.GeminiModel) ?? _config.GeminiModel;
        var localCerebrasModel = IsDisabledModelSelection(request.CerebrasModel)
            ? "none"
            : NormalizeModelSelection(request.CerebrasModel) ?? _config.CerebrasModel;
        var localCopilotModel = IsDisabledModelSelection(request.CopilotModel)
            ? "none"
            : NormalizeModelSelection(request.CopilotModel) ?? _copilotWrapper.GetSelectedModel();
        var localCodexModel = IsDisabledModelSelection(request.CodexModel)
            ? "none"
            : NormalizeModelSelection(request.CodexModel) ?? _config.CodexModel;
        var requestedSummaryProvider = NormalizeProvider(request.SummaryProvider, allowAuto: true);
        var localUsageReply = await TryBuildInChatCopilotUsageResponseAsync(rawInput, request.Source, cancellationToken);
        if (!string.IsNullOrWhiteSpace(localUsageReply))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, "local:copilot_usage");
            _conversationStore.AppendMessage(thread.Id, "assistant", localUsageReply, "local:copilot_usage");
            await EnsureConversationTitleFromFirstTurnAsync(
                thread.Id,
                "local",
                "copilot_usage",
                cancellationToken
            );

            var localUpdated = _conversationStore.Get(thread.Id) ?? thread;
            return new ConversationMultiResult(
                localUpdated.Id,
                "로컬 사용량 조회로 Groq 응답은 생략되었습니다.",
                "로컬 사용량 조회로 Gemini 응답은 생략되었습니다.",
                "로컬 사용량 조회로 Cerebras 응답은 생략되었습니다.",
                "로컬 사용량 조회로 Copilot 응답은 생략되었습니다.",
                localUsageReply,
                localGroqModel,
                localGeminiModel,
                localCerebrasModel,
                localCopilotModel,
                requestedSummaryProvider,
                "local",
                localUpdated,
                null,
                null,
                null,
                null,
                null,
                "로컬 사용량 조회로 Codex 응답은 생략되었습니다.",
                localCodexModel
            );
        }

        var basePrepared = await PrepareSharedInputAsync(
            rawInput,
            request.Attachments,
            request.WebUrls,
            request.WebSearchEnabled,
            cancellationToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(basePrepared.UnsupportedMessage))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, "multi");
            _conversationStore.AppendMessage(thread.Id, "assistant", basePrepared.UnsupportedMessage, "multi:unsupported");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "chat-multi-unsupported",
                basePrepared.Citations,
                ("summary", basePrepared.UnsupportedMessage)
            );
            return new ConversationMultiResult(
                blockedView.Id,
                basePrepared.UnsupportedMessage,
                basePrepared.UnsupportedMessage,
                basePrepared.UnsupportedMessage,
                basePrepared.UnsupportedMessage,
                basePrepared.UnsupportedMessage,
                localGroqModel,
                localGeminiModel,
                localCerebrasModel,
                localCopilotModel,
                requestedSummaryProvider,
                "blocked",
                blockedView,
                null,
                basePrepared.GuardFailure,
                basePrepared.Citations,
                blockedCitationBundle.Mappings,
                blockedCitationBundle.Validation,
                basePrepared.UnsupportedMessage,
                localCodexModel
            );
        }
        var contextualInput = BuildContextualInput(session.SessionId, basePrepared.Text, session.LinkedMemoryNotes);

        var generated = await ChatMultiAsync(
            contextualInput,
            request.Source,
            request.GroqModel,
            request.GeminiModel,
            request.CopilotModel,
            request.CerebrasModel,
            request.SummaryProvider,
            request.CodexModel,
            request.Attachments,
            cancellationToken
        );

        var citationBundle = BuildAndLogCitationMappings(
            request.Source,
            "chat-multi",
            basePrepared.Citations,
            ("groq", generated.GroqText),
            ("gemini", generated.GeminiText),
            ("cerebras", generated.CerebrasText),
            ("copilot", generated.CopilotText),
            ("codex", generated.CodexText),
            ("summary", generated.Summary)
        );
        var effectiveGuardFailure = basePrepared.GuardFailure;
        var responseGroqText = generated.GroqText;
        var responseGeminiText = generated.GeminiText;
        var responseCerebrasText = generated.CerebrasText;
        var responseCopilotText = generated.CopilotText;
        var responseCodexText = generated.CodexText;
        var responseSummaryText = generated.Summary;

        var assistantText = BuildMultiAssistantText(new LlmMultiChatResult(
            responseGroqText,
            responseGeminiText,
            responseCerebrasText,
            responseCopilotText,
            responseSummaryText,
            generated.GroqModel,
            generated.GeminiModel,
            generated.CerebrasModel,
            generated.CopilotModel,
            generated.RequestedSummaryProvider,
            generated.ResolvedSummaryProvider,
            responseCodexText,
            generated.CodexModel
        ));
        _conversationStore.AppendMessage(thread.Id, "user", rawInput, "multi");
        _conversationStore.AppendMessage(thread.Id, "assistant", assistantText, $"summary={generated.ResolvedSummaryProvider}");
        await EnsureConversationTitleFromFirstTurnAsync(
            thread.Id,
            generated.ResolvedSummaryProvider,
            string.Empty,
            cancellationToken
        );

        var note = await MaybeCompressConversationAsync(
            thread.Id,
            $"{session.Scope}-{session.Mode}",
            generated.ResolvedSummaryProvider,
            string.Empty,
            cancellationToken
        );

        var updated = _conversationStore.Get(thread.Id) ?? thread;
        return new ConversationMultiResult(
            updated.Id,
            responseGroqText,
            responseGeminiText,
            responseCerebrasText,
            responseCopilotText,
            responseSummaryText,
            generated.GroqModel,
            generated.GeminiModel,
            generated.CerebrasModel,
            generated.CopilotModel,
            generated.RequestedSummaryProvider,
            generated.ResolvedSummaryProvider,
            updated,
            note,
            effectiveGuardFailure,
            basePrepared.Citations,
            citationBundle.Mappings,
            citationBundle.Validation,
            responseCodexText,
            generated.CodexModel
        );
    }


    private async Task<LlmSingleChatResult> ChatSingleCoreAsync(
        string input,
        string provider,
        string? model,
        string source,
        CancellationToken cancellationToken,
        int? maxOutputTokens = null
    )
    {
        var text = (input ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return new LlmSingleChatResult(provider, model ?? "-", "empty input");
        }

        var generated = await GenerateByProviderSafeAsync(
            provider,
            model,
            text,
            cancellationToken,
            maxOutputTokens
        );
        var cleaned = SanitizeChatOutput(generated.Text);
        _auditLogger.Log(source, "chat_single", "ok", $"provider={generated.Provider} model={generated.Model}");
        return new LlmSingleChatResult(generated.Provider, generated.Model, cleaned);
    }

    private async Task<LlmOrchestrationResult> ChatOrchestrationCoreAsync(
        string input,
        string source,
        string? provider,
        string? model,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
        string? codexModel,
        IReadOnlyList<InputAttachment>? attachments,
        CancellationToken cancellationToken
    )
    {
        var text = (input ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return new LlmOrchestrationResult("unknown", "empty input");
        }

        var workerTasks = new List<Task<LlmSingleChatResult>>();
        if (_llmRouter.HasGroqApiKey() && !IsDisabledModelSelection(groqModel))
        {
            var selectedGroq = string.IsNullOrWhiteSpace(groqModel) ? null : groqModel.Trim();
            workerTasks.Add(ExecuteProviderChatWithPreparedInputAsync("groq", selectedGroq, text, attachments, cancellationToken));
        }

        if (_llmRouter.HasGeminiApiKey() && !IsDisabledModelSelection(geminiModel))
        {
            var selectedGemini = string.IsNullOrWhiteSpace(geminiModel) ? null : geminiModel.Trim();
            workerTasks.Add(ExecuteProviderChatWithPreparedInputAsync("gemini", selectedGemini, text, attachments, cancellationToken));
        }

        if (_llmRouter.HasCerebrasApiKey() && !IsDisabledModelSelection(cerebrasModel))
        {
            var selectedCerebras = string.IsNullOrWhiteSpace(cerebrasModel) ? null : cerebrasModel.Trim();
            workerTasks.Add(ExecuteProviderChatWithPreparedInputAsync("cerebras", selectedCerebras, text, attachments, cancellationToken));
        }

        var copilotStatus = await _copilotWrapper.GetStatusAsync(cancellationToken);
        if (copilotStatus.Installed && copilotStatus.Authenticated && !IsDisabledModelSelection(copilotModel))
        {
            var selectedCopilot = string.IsNullOrWhiteSpace(copilotModel) ? _copilotWrapper.GetSelectedModel() : copilotModel.Trim();
            workerTasks.Add(ExecuteProviderChatWithPreparedInputAsync("copilot", selectedCopilot, text, attachments, cancellationToken));
        }

        var codexStatus = await _codexWrapper.GetStatusAsync(cancellationToken);
        if (codexStatus.Installed && codexStatus.Authenticated && !IsDisabledModelSelection(codexModel))
        {
            var selectedCodex = NormalizeModelSelection(codexModel) ?? _config.CodexModel;
            workerTasks.Add(ExecuteProviderChatWithPreparedInputAsync("codex", selectedCodex, text, attachments, cancellationToken));
        }

        if (workerTasks.Count == 0)
        {
            return new LlmOrchestrationResult("no_provider", "사용 가능한 LLM이 없습니다. Groq/Gemini/Cerebras 키 또는 Copilot/Codex 인증을 확인하세요.");
        }

        await Task.WhenAll(workerTasks);
        var workerResults = workerTasks
            .Select(x =>
            {
                var result = x.Result;
                return new LlmSingleChatResult(result.Provider, result.Model, SanitizeChatOutput(result.Text));
            })
            .ToList();
        var availabilityByProvider = await GetProviderAvailabilityMapAsync(cancellationToken);
        var selectionByProvider = BuildProviderSelectionMap(groqModel, geminiModel, cerebrasModel, copilotModel, codexModel);
        var successfulWorkers = workerResults
            .Where(x => IsUsableWorkerResult(x, availabilityByProvider, selectionByProvider))
            .ToArray();

        var requestedProvider = NormalizeProvider(provider, allowAuto: true);
        var resolvedProvider = ResolveProviderForAggregation(
            requestedProvider,
            successfulWorkers,
            availabilityByProvider,
            selectionByProvider,
            allowProviderWithoutWorkerFallback: true
        );
        if (resolvedProvider == "none")
        {
            resolvedProvider = workerResults[0].Provider;
        }

        if ((resolvedProvider == "groq" && IsDisabledModelSelection(groqModel))
            || (resolvedProvider == "gemini" && IsDisabledModelSelection(geminiModel))
            || (resolvedProvider == "cerebras" && IsDisabledModelSelection(cerebrasModel))
            || (resolvedProvider == "copilot" && IsDisabledModelSelection(copilotModel))
            || (resolvedProvider == "codex" && IsDisabledModelSelection(codexModel)))
        {
            resolvedProvider = workerResults[0].Provider;
        }

        var aggregateModel = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
        if (string.IsNullOrWhiteSpace(aggregateModel))
        {
            aggregateModel = resolvedProvider == "groq"
                ? (string.IsNullOrWhiteSpace(groqModel) ? _llmRouter.GetSelectedGroqModel() : groqModel.Trim())
                : resolvedProvider == "copilot"
                    ? (string.IsNullOrWhiteSpace(copilotModel) ? _copilotWrapper.GetSelectedModel() : copilotModel.Trim())
                    : resolvedProvider == "codex"
                        ? (NormalizeModelSelection(codexModel) ?? _config.CodexModel)
                    : resolvedProvider == "cerebras"
                        ? (string.IsNullOrWhiteSpace(cerebrasModel) ? _config.CerebrasModel : cerebrasModel.Trim())
                    : (string.IsNullOrWhiteSpace(geminiModel) ? _config.GeminiModel : geminiModel.Trim());
        }

        var aggregatePrompt = BuildOrchestrationPrompt(text, workerResults);
        var finalResult = await GenerateByProviderSafeAsync(
            resolvedProvider,
            aggregateModel,
            aggregatePrompt,
            cancellationToken
        );
        var cleanedFinal = SanitizeChatOutput(finalResult.Text);

        var workerRoute = string.Join(
            ",",
            workerResults.Select(x => $"{x.Provider}:{x.Model}")
        );
        var route = $"orchestration_parallel[{workerRoute}]=>{finalResult.Provider}:{finalResult.Model}";
        _auditLogger.Log(source, "chat_orchestration", "ok", route);
        return new LlmOrchestrationResult(route, cleanedFinal);
    }

    private async Task<LlmMultiChatResult> ChatMultiCoreAsync(
        string input,
        string source,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
        string? summaryProvider,
        string? codexModel,
        IReadOnlyList<InputAttachment>? attachments,
        CancellationToken cancellationToken
    )
    {
        var text = (input ?? string.Empty).Trim();
        var hasGroqOverride = !string.IsNullOrWhiteSpace(groqModel) && !IsDisabledModelSelection(groqModel);
        var groqSelected = hasGroqOverride ? groqModel!.Trim() : _llmRouter.GetSelectedGroqModel();
        var geminiSelected = NormalizeModelSelection(geminiModel) ?? _config.GeminiModel;
        var cerebrasSelected = NormalizeModelSelection(cerebrasModel) ?? _config.CerebrasModel;
        var copilotSelected = NormalizeModelSelection(copilotModel) ?? _copilotWrapper.GetSelectedModel();
        var codexSelected = NormalizeModelSelection(codexModel) ?? _config.CodexModel;
        var groqResolvedModel = IsDisabledModelSelection(groqModel) ? "none" : groqSelected;
        var geminiResolvedModel = IsDisabledModelSelection(geminiModel) ? "none" : geminiSelected;
        var cerebrasResolvedModel = IsDisabledModelSelection(cerebrasModel) ? "none" : cerebrasSelected;
        var copilotResolvedModel = IsDisabledModelSelection(copilotModel) ? "none" : copilotSelected;
        var codexResolvedModel = IsDisabledModelSelection(codexModel) ? "none" : codexSelected;
        var requestedSummaryProvider = NormalizeProvider(summaryProvider, allowAuto: true);
        if (string.IsNullOrWhiteSpace(text))
        {
            return new LlmMultiChatResult(
                "empty input",
                "empty input",
                "empty input",
                "empty input",
                "empty input",
                groqResolvedModel,
                geminiResolvedModel,
                cerebrasResolvedModel,
                copilotResolvedModel,
                requestedSummaryProvider,
                "none",
                "empty input",
                codexResolvedModel
            );
        }

        Task<LlmSingleChatResult> groqTask = IsDisabledModelSelection(groqModel)
            ? Task.FromResult(new LlmSingleChatResult("groq", "none", "선택 안함"))
            : _llmRouter.HasGroqApiKey()
                ? ExecuteProviderChatWithPreparedInputAsync("groq", hasGroqOverride ? groqSelected : null, text, attachments, cancellationToken)
                : Task.FromResult(new LlmSingleChatResult("groq", groqSelected, "Groq API 키가 설정되지 않았습니다."));

        Task<LlmSingleChatResult> geminiTask = IsDisabledModelSelection(geminiModel)
            ? Task.FromResult(new LlmSingleChatResult("gemini", "none", "선택 안함"))
            : _llmRouter.HasGeminiApiKey()
                ? ExecuteProviderChatWithPreparedInputAsync("gemini", geminiSelected, text, attachments, cancellationToken)
                : Task.FromResult(new LlmSingleChatResult("gemini", geminiSelected, "Gemini API 키가 설정되지 않았습니다."));

        Task<LlmSingleChatResult> cerebrasTask = IsDisabledModelSelection(cerebrasModel)
            ? Task.FromResult(new LlmSingleChatResult("cerebras", "none", "선택 안함"))
            : _llmRouter.HasCerebrasApiKey()
                ? ExecuteProviderChatWithPreparedInputAsync("cerebras", cerebrasSelected, text, attachments, cancellationToken)
                : Task.FromResult(new LlmSingleChatResult("cerebras", cerebrasSelected, "Cerebras API 키가 설정되지 않았습니다."));

        var copilotStatus = await _copilotWrapper.GetStatusAsync(cancellationToken);
        Task<LlmSingleChatResult> copilotTask = IsDisabledModelSelection(copilotModel)
            ? Task.FromResult(new LlmSingleChatResult("copilot", "none", "선택 안함"))
            : (copilotStatus.Installed && copilotStatus.Authenticated
                ? ExecuteProviderChatWithPreparedInputAsync("copilot", copilotSelected, text, attachments, cancellationToken)
                : Task.FromResult(new LlmSingleChatResult("copilot", copilotSelected, "Copilot 인증이 필요합니다.")));
        var codexStatus = await _codexWrapper.GetStatusAsync(cancellationToken);
        Task<LlmSingleChatResult> codexTask = IsDisabledModelSelection(codexModel)
            ? Task.FromResult(new LlmSingleChatResult("codex", "none", "선택 안함"))
            : (codexStatus.Installed && codexStatus.Authenticated
                ? ExecuteProviderChatWithPreparedInputAsync("codex", codexSelected, text, attachments, cancellationToken)
                : Task.FromResult(new LlmSingleChatResult("codex", codexSelected, "Codex 인증이 필요합니다.")));

        await Task.WhenAll(groqTask, geminiTask, cerebrasTask, copilotTask, codexTask);
        var workerResults = new[]
        {
            new LlmSingleChatResult(groqTask.Result.Provider, groqTask.Result.Model, SanitizeChatOutput(groqTask.Result.Text)),
            new LlmSingleChatResult(geminiTask.Result.Provider, geminiTask.Result.Model, SanitizeChatOutput(geminiTask.Result.Text)),
            new LlmSingleChatResult(cerebrasTask.Result.Provider, cerebrasTask.Result.Model, SanitizeChatOutput(cerebrasTask.Result.Text)),
            new LlmSingleChatResult(copilotTask.Result.Provider, copilotTask.Result.Model, SanitizeChatOutput(copilotTask.Result.Text)),
            new LlmSingleChatResult(codexTask.Result.Provider, codexTask.Result.Model, SanitizeChatOutput(codexTask.Result.Text))
        };
        var availabilityByProvider = await GetProviderAvailabilityMapAsync(cancellationToken);
        var selectionByProvider = BuildProviderSelectionMap(groqModel, geminiModel, cerebrasModel, copilotModel, codexModel);
        var successfulWorkers = workerResults
            .Where(x => IsUsableWorkerResult(x, availabilityByProvider, selectionByProvider))
            .ToArray();

        var groq = workerResults[0].Text;
        var gemini = workerResults[1].Text;
        var cerebras = workerResults[2].Text;
        var copilot = workerResults[3].Text;
        var codex = workerResults[4].Text;

        var summaryPrompt = $"""
                            사용자 질문:
                            {text}

                            [Groq]
                            {groq}

                            [Gemini]
                            {gemini}

                            [Cerebras]
                            {cerebras}

                            [Copilot]
                            {copilot}

                            [Codex]
                            {codex}

                            위 5개 답변에서 서로 중복/공통되는 핵심만 우선 정리하세요.
                            출력 형식:
                            [공통 핵심]
                            - ...
                            [부분 차이]
                            - ...
                            공통점이 전혀 없으면 [공통 핵심]에 "공통점 없음"이라고 쓰세요.
                            """;
        var resolvedSummaryProvider = ResolveProviderForAggregation(
            requestedSummaryProvider,
            successfulWorkers,
            availabilityByProvider,
            selectionByProvider,
            allowProviderWithoutWorkerFallback: false
        );

        string summary;
        if (resolvedSummaryProvider == "none")
        {
            summary = "요약: 사용 가능한 LLM이 없어 자동 요약을 건너뜁니다.";
        }
        else
        {
            var summaryResult = await GenerateByProviderSafeAsync(resolvedSummaryProvider, null, summaryPrompt, cancellationToken);
            summary = SanitizeChatOutput(summaryResult.Text);
        }

        _auditLogger.Log(source, "chat_multi", "ok", $"groq={groqSelected} cerebras={cerebrasSelected} copilot={copilotSelected} codex={codexSelected} summary={resolvedSummaryProvider}");
        return new LlmMultiChatResult(
            groq,
            gemini,
            cerebras,
            copilot,
            summary,
            groqResolvedModel,
            geminiResolvedModel,
            cerebrasResolvedModel,
            copilotResolvedModel,
            requestedSummaryProvider,
            resolvedSummaryProvider,
            codex,
            codexResolvedModel
        );
    }

}
