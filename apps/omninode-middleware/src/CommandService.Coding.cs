namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    public Task<CodingRunResult> RunCodingSingleAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
    )
    {
        return RunCodingSingleCoreAsync(request, cancellationToken, progressCallback);
    }

    public Task<CodingRunResult> RunCodingOrchestrationAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
    )
    {
        return RunCodingOrchestrationCoreAsync(request, cancellationToken, progressCallback);
    }

    public Task<CodingRunResult> RunCodingMultiAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
    )
    {
        return RunCodingMultiCoreAsync(request, cancellationToken, progressCallback);
    }

    private async Task<CodingRunResult> RunCodingSingleCoreAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
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

        var provider = NormalizeProvider(request.Provider, allowAuto: true);
        if (provider == "auto")
        {
            provider = await ResolveAutoProviderAsync(cancellationToken);
            if (provider == "none")
            {
                provider = "groq";
            }
        }

        var model = ResolveModel(provider, request.Model);
        var preparedInput = await PrepareInputForProviderAsync(
            rawInput,
            provider,
            model,
            request.Attachments,
            request.WebUrls,
            request.WebSearchEnabled,
            true,
            cancellationToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(preparedInput.UnsupportedMessage))
        {
            var blockedExecution = new CodeExecutionResult(
                request.Language,
                ResolveWorkspaceRoot(),
                "-",
                "(none)",
                0,
                "첨부 해석을 수행하지 않았습니다.",
                preparedInput.UnsupportedMessage,
                "skipped"
            );
            var blockedText = BuildCodingAssistantText(
                "single",
                provider,
                model,
                request.Language,
                blockedExecution,
                Array.Empty<string>(),
                preparedInput.UnsupportedMessage
            );
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"coding:{provider}:{model}");
            _conversationStore.AppendMessage(thread.Id, "assistant", blockedText, $"coding:{provider}:{model}");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "coding-single-unsupported",
                preparedInput.Citations,
                ("summary", preparedInput.UnsupportedMessage)
            );
            return new CodingRunResult(
                "single",
                blockedView.Id,
                provider,
                model,
                request.Language,
                string.Empty,
                blockedExecution,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                preparedInput.UnsupportedMessage,
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

        var contextualInput = BuildContextualInput(session.SessionId, preparedInput.Text, session.LinkedMemoryNotes);
        var objective = BuildCodingAgentObjectivePrompt(contextualInput, request.Language, "단일 모델 코딩");
        var outcome = await RunAutonomousCodingLoopAsync(
            provider,
            model,
            objective,
            request.Language,
            "single",
            cancellationToken,
            progressCallback
        );

        var citationBundle = BuildAndLogCitationMappings(
            request.Source,
            "coding-single",
            preparedInput.Citations,
            ("summary", outcome.Summary)
        );
        var citationValidationGuardFailure = BuildCitationValidationGuardFailure(citationBundle.Validation);
        var effectiveGuardFailure = preparedInput.GuardFailure ?? citationValidationGuardFailure;
        var responseSummary = outcome.Summary;
        var assistantText = BuildCodingAssistantText(
            "single",
            provider,
            model,
            outcome.Language,
            outcome.Execution,
            outcome.ChangedFiles,
            responseSummary
        );
        if (citationValidationGuardFailure is not null)
        {
            LogCitationValidationGuardBlocked(request.Source, "coding-single", citationValidationGuardFailure);
            responseSummary = BuildCitationValidationBlockedResponseText(citationValidationGuardFailure);
            assistantText = responseSummary;
        }

        _conversationStore.AppendMessage(thread.Id, "user", rawInput, $"coding:{provider}:{model}");
        _conversationStore.AppendMessage(thread.Id, "assistant", assistantText, $"coding:{provider}:{model}");
        await EnsureConversationTitleFromFirstTurnAsync(thread.Id, provider, model, cancellationToken);

        var note = await MaybeCompressConversationAsync(thread.Id, $"{session.Scope}-{session.Mode}", provider, model, cancellationToken);
        var updated = _conversationStore.Get(thread.Id) ?? thread;
        return new CodingRunResult(
            "single",
            updated.Id,
            provider,
            model,
            outcome.Language,
            outcome.Code,
            outcome.Execution,
            Array.Empty<CodingWorkerResult>(),
            outcome.ChangedFiles,
            responseSummary,
            updated,
            note,
            effectiveGuardFailure,
            preparedInput.Citations,
            citationBundle.Mappings,
            citationBundle.Validation,
            preparedInput.RetryAttempt,
            preparedInput.RetryMaxAttempts,
            preparedInput.RetryStopReason
        );
    }

    private async Task<CodingRunResult> RunCodingOrchestrationCoreAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
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
        var autoRoleMode = string.IsNullOrWhiteSpace(rawInput);
        var effectiveInput = autoRoleMode
            ? BuildAutoOrchestrationCodingInput(request.Language)
            : rawInput;
        var sharedPrepared = await PrepareSharedInputAsync(
            effectiveInput,
            request.Attachments,
            request.WebUrls,
            request.WebSearchEnabled,
            cancellationToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(sharedPrepared.UnsupportedMessage))
        {
            var blockedUserText = autoRoleMode
                ? "[AUTO] 입력 없이 실행: 워커 자동 역할 협의 모드"
                : rawInput;
            _conversationStore.AppendMessage(thread.Id, "user", blockedUserText, "coding-orchestration");
            _conversationStore.AppendMessage(thread.Id, "assistant", sharedPrepared.UnsupportedMessage, "coding-orchestration:unsupported");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedExecution = new CodeExecutionResult(
                request.Language,
                "-",
                "-",
                "(none)",
                0,
                string.Empty,
                sharedPrepared.UnsupportedMessage,
                "skipped"
            );
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "coding-orchestration-unsupported",
                sharedPrepared.Citations,
                ("summary", sharedPrepared.UnsupportedMessage)
            );
            return new CodingRunResult(
                "orchestration",
                blockedView.Id,
                "-",
                "-",
                request.Language,
                string.Empty,
                blockedExecution,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                sharedPrepared.UnsupportedMessage,
                blockedView,
                null,
                sharedPrepared.GuardFailure,
                sharedPrepared.Citations,
                blockedCitationBundle.Mappings,
                blockedCitationBundle.Validation,
                sharedPrepared.RetryAttempt,
                sharedPrepared.RetryMaxAttempts,
                sharedPrepared.RetryStopReason
            );
        }
        var contextualInput = BuildContextualInput(session.SessionId, sharedPrepared.Text, session.LinkedMemoryNotes);

        var availableProviders = await GetAvailableProvidersAsync(cancellationToken);
        if (availableProviders.Count == 0)
        {
            var emptyResult = new CodeExecutionResult(request.Language, "-", "-", "-", 1, string.Empty, "사용 가능한 모델이 없습니다.", "error");
            var citationBundleUnavailable = BuildAndLogCitationMappings(
                request.Source,
                "coding-orchestration-unavailable",
                sharedPrepared.Citations,
                ("summary", "모델 사용 불가")
            );
            return new CodingRunResult(
                "orchestration",
                thread.Id,
                "-",
                "-",
                request.Language,
                string.Empty,
                emptyResult,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                "모델 사용 불가",
                thread,
                null,
                sharedPrepared.GuardFailure,
                sharedPrepared.Citations,
                citationBundleUnavailable.Mappings,
                citationBundleUnavailable.Validation,
                sharedPrepared.RetryAttempt,
                sharedPrepared.RetryMaxAttempts,
                sharedPrepared.RetryStopReason
            );
        }

        var workerProviders = availableProviders
            .Where(provider =>
            {
                var selection = provider switch
                {
                    "groq" => request.GroqModel,
                    "gemini" => request.GeminiModel,
                    "cerebras" => request.CerebrasModel,
                    "copilot" => request.CopilotModel,
                    "codex" => request.CodexModel,
                    _ => null
                };
                return !IsDisabledModelSelection(selection);
            })
            .ToArray();
        if (workerProviders.Length == 0)
        {
            var emptyResult = new CodeExecutionResult(request.Language, "-", "-", "-", 1, string.Empty, "워커가 모두 '선택 안함'으로 설정되었습니다.", "error");
            var citationBundleWorkersDisabled = BuildAndLogCitationMappings(
                request.Source,
                "coding-orchestration-workers-disabled",
                sharedPrepared.Citations,
                ("summary", "모델 사용 불가")
            );
            return new CodingRunResult(
                "orchestration",
                thread.Id,
                "-",
                "-",
                request.Language,
                string.Empty,
                emptyResult,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                "모델 사용 불가",
                thread,
                null,
                sharedPrepared.GuardFailure,
                sharedPrepared.Citations,
                citationBundleWorkersDisabled.Mappings,
                citationBundleWorkersDisabled.Validation,
                sharedPrepared.RetryAttempt,
                sharedPrepared.RetryMaxAttempts,
                sharedPrepared.RetryStopReason
            );
        }

        var resolvedWorkerModels = workerProviders.ToDictionary(
            provider => provider,
            provider => ResolveModel(
                provider,
                provider switch
                {
                    "groq" => request.GroqModel,
                    "gemini" => request.GeminiModel,
                    "cerebras" => request.CerebrasModel,
                    "copilot" => request.CopilotModel,
                    "codex" => request.CodexModel,
                    _ => null
                }
            ),
            StringComparer.OrdinalIgnoreCase
        );
        var workerRoles = autoRoleMode
            ? await NegotiateOrchestrationRolesAsync(workerProviders, resolvedWorkerModels, contextualInput, request.Language, cancellationToken)
            : BuildDefaultOrchestrationRoles(workerProviders);
        var workerPlan = workerProviders
            .Select(provider =>
            {
                workerRoles.TryGetValue(provider, out var role);
                var effectiveRole = string.IsNullOrWhiteSpace(role)
                    ? "구현자. 동작 코드 중심으로 작성하세요."
                    : role;
                return (Provider: provider, RolePrompt: $"역할: {effectiveRole}");
            })
            .ToList();

        var workerTasks = new List<Task<CodingWorkerResult>>();
        for (var i = 0; i < workerPlan.Count; i++)
        {
            var provider = workerPlan[i].Provider;
            var rolePrompt = workerPlan[i].RolePrompt;
            var model = resolvedWorkerModels[provider];
            var providerPrepared = await PrepareInputForProviderAsync(
                contextualInput + "\n\n" + rolePrompt,
                provider,
                model,
                request.Attachments,
                request.WebUrls,
                request.WebSearchEnabled,
                false,
                cancellationToken
            );
            if (!string.IsNullOrWhiteSpace(providerPrepared.UnsupportedMessage))
            {
                workerTasks.Add(Task.FromResult(BuildUnsupportedCodingWorkerResult(
                    provider,
                    model,
                    request.Language,
                    providerPrepared.UnsupportedMessage
                )));
                continue;
            }

            var prompt = BuildCodingAgentObjectivePrompt(
                providerPrepared.Text,
                request.Language,
                $"오케스트레이션 워커-{i + 1}"
            );

            workerTasks.Add(
                RunCodingWorkerAsync(
                    provider,
                    model,
                    prompt,
                    request.Language,
                    cancellationToken,
                    progressCallback,
                    "orchestration-worker"
                )
            );
        }

        await Task.WhenAll(workerTasks);
        var workerResults = workerTasks.Select(x => x.Result).ToArray();
        var availabilityByProvider = await GetProviderAvailabilityMapAsync(cancellationToken);
        var selectionByProvider = BuildProviderSelectionMap(
            request.GroqModel,
            request.GeminiModel,
            request.CerebrasModel,
            request.CopilotModel,
            request.CodexModel
        );
        var workerChatResults = workerResults
            .Select(x => new LlmSingleChatResult(x.Provider, x.Model, x.RawResponse))
            .ToArray();
        var successfulWorkers = workerChatResults
            .Where(x => IsUsableWorkerResult(x, availabilityByProvider, selectionByProvider))
            .ToArray();
        var requestedProvider = NormalizeProvider(request.Provider, allowAuto: true);
        var aggregateProvider = ResolveProviderForAggregation(
            requestedProvider,
            successfulWorkers,
            availabilityByProvider,
            selectionByProvider,
            allowProviderWithoutWorkerFallback: true
        );
        if (aggregateProvider == "none")
        {
            aggregateProvider = workerResults[0].Provider;
        }
        else if (selectionByProvider.TryGetValue(aggregateProvider, out var selection)
            && IsDisabledModelSelection(selection))
        {
            aggregateProvider = workerResults[0].Provider;
        }

        var aggregateModelOverride = request.Model;
        if (string.IsNullOrWhiteSpace(aggregateModelOverride))
        {
            aggregateModelOverride = aggregateProvider switch
            {
                "groq" => request.GroqModel,
                "gemini" => request.GeminiModel,
                "cerebras" => request.CerebrasModel,
                "copilot" => request.CopilotModel,
                "codex" => request.CodexModel,
                _ => null
            };
        }

        var aggregateModel = ResolveModel(aggregateProvider, aggregateModelOverride);
        var aggregatePrompt = BuildCodingAgentObjectivePrompt(
            BuildOrchestrationCodingAggregatePrompt(contextualInput, workerResults, request.Language),
            request.Language,
            "오케스트레이션 통합"
        );
        var finalOutcome = await RunAutonomousCodingLoopAsync(
            aggregateProvider,
            aggregateModel,
            aggregatePrompt,
            request.Language,
            "orchestration",
            cancellationToken,
            progressCallback
        );

        var workersSummary = string.Join("\n", workerResults.Select(x => $"- {x.Provider}:{x.Model} ({x.Language})"));
        var orchestrationSummary = workersSummary + "\n\n" + finalOutcome.Summary;
        var citationBundleOrchestration = BuildAndLogCitationMappings(
            request.Source,
            "coding-orchestration",
            sharedPrepared.Citations,
            ("summary", orchestrationSummary)
        );
        var citationValidationGuardFailure = BuildCitationValidationGuardFailure(citationBundleOrchestration.Validation);
        var effectiveGuardFailure = sharedPrepared.GuardFailure ?? citationValidationGuardFailure;
        var responseSummary = orchestrationSummary;
        var assistantText = BuildCodingAssistantText(
            "orchestration",
            aggregateProvider,
            aggregateModel,
            finalOutcome.Language,
            finalOutcome.Execution,
            finalOutcome.ChangedFiles,
            responseSummary
        );
        if (citationValidationGuardFailure is not null)
        {
            LogCitationValidationGuardBlocked(request.Source, "coding-orchestration", citationValidationGuardFailure);
            responseSummary = BuildCitationValidationBlockedResponseText(citationValidationGuardFailure);
            assistantText = responseSummary;
        }
        var conversationUserText = autoRoleMode
            ? "[AUTO] 입력 없이 실행: 워커 자동 역할 협의 모드"
            : rawInput;
        _conversationStore.AppendMessage(thread.Id, "user", conversationUserText, "coding-orchestration");
        _conversationStore.AppendMessage(thread.Id, "assistant", assistantText, $"coding-orchestration:{aggregateProvider}:{aggregateModel}");
        await EnsureConversationTitleFromFirstTurnAsync(thread.Id, aggregateProvider, aggregateModel, cancellationToken);

        var note = await MaybeCompressConversationAsync(thread.Id, $"{session.Scope}-{session.Mode}", aggregateProvider, aggregateModel, cancellationToken);
        var updated = _conversationStore.Get(thread.Id) ?? thread;
        return new CodingRunResult(
            "orchestration",
            updated.Id,
            aggregateProvider,
            aggregateModel,
            finalOutcome.Language,
            finalOutcome.Code,
            finalOutcome.Execution,
            workerResults,
            finalOutcome.ChangedFiles,
            responseSummary,
            updated,
            note,
            effectiveGuardFailure,
            sharedPrepared.Citations,
            citationBundleOrchestration.Mappings,
            citationBundleOrchestration.Validation,
            sharedPrepared.RetryAttempt,
            sharedPrepared.RetryMaxAttempts,
            sharedPrepared.RetryStopReason
        );
    }

    private async Task<CodingRunResult> RunCodingMultiCoreAsync(
        CodingRunRequest request,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null
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
        var sharedPrepared = await PrepareSharedInputAsync(
            rawInput,
            request.Attachments,
            request.WebUrls,
            request.WebSearchEnabled,
            cancellationToken,
            request.Source,
            session.SessionKey,
            session.SessionId
        );
        if (!string.IsNullOrWhiteSpace(sharedPrepared.UnsupportedMessage))
        {
            _conversationStore.AppendMessage(thread.Id, "user", rawInput, "coding-multi");
            _conversationStore.AppendMessage(thread.Id, "assistant", sharedPrepared.UnsupportedMessage, "coding-multi:unsupported");
            var blockedView = _conversationStore.Get(thread.Id) ?? thread;
            var blockedExecution = new CodeExecutionResult(
                request.Language,
                "-",
                "-",
                "(none)",
                0,
                string.Empty,
                sharedPrepared.UnsupportedMessage,
                "skipped"
            );
            var blockedCitationBundle = BuildAndLogCitationMappings(
                request.Source,
                "coding-multi-unsupported",
                sharedPrepared.Citations,
                ("summary", sharedPrepared.UnsupportedMessage)
            );
            return new CodingRunResult(
                "multi",
                blockedView.Id,
                "-",
                "-",
                request.Language,
                string.Empty,
                blockedExecution,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                sharedPrepared.UnsupportedMessage,
                blockedView,
                null,
                sharedPrepared.GuardFailure,
                sharedPrepared.Citations,
                blockedCitationBundle.Mappings,
                blockedCitationBundle.Validation,
                sharedPrepared.RetryAttempt,
                sharedPrepared.RetryMaxAttempts,
                sharedPrepared.RetryStopReason
            );
        }
        var contextualInput = BuildContextualInput(session.SessionId, sharedPrepared.Text, session.LinkedMemoryNotes);
        var workers = await GetAvailableProvidersAsync(cancellationToken);
        workers = workers
            .Where(provider =>
            {
                var selection = provider switch
                {
                    "groq" => request.GroqModel,
                    "gemini" => request.GeminiModel,
                    "cerebras" => request.CerebrasModel,
                    "copilot" => request.CopilotModel,
                    "codex" => request.CodexModel,
                    _ => null
                };
                return !IsDisabledModelSelection(selection);
            })
            .ToArray();
        if (workers.Count == 0)
        {
            var emptyResult = new CodeExecutionResult(request.Language, "-", "-", "-", 1, string.Empty, "다중 코딩 워커가 모두 '선택 안함' 또는 미사용 상태입니다.", "error");
            var citationBundleWorkersDisabled = BuildAndLogCitationMappings(
                request.Source,
                "coding-multi-workers-disabled",
                sharedPrepared.Citations,
                ("summary", "모델 사용 불가")
            );
            return new CodingRunResult(
                "multi",
                thread.Id,
                "-",
                "-",
                request.Language,
                string.Empty,
                emptyResult,
                Array.Empty<CodingWorkerResult>(),
                Array.Empty<string>(),
                "모델 사용 불가",
                thread,
                null,
                sharedPrepared.GuardFailure,
                sharedPrepared.Citations,
                citationBundleWorkersDisabled.Mappings,
                citationBundleWorkersDisabled.Validation,
                sharedPrepared.RetryAttempt,
                sharedPrepared.RetryMaxAttempts,
                sharedPrepared.RetryStopReason
            );
        }

        var workerTaskList = new List<Task<CodingWorkerResult>>();
        foreach (var provider in workers)
        {
            var model = ResolveModel(
                provider,
                provider switch
                {
                    "groq" => request.GroqModel,
                    "gemini" => request.GeminiModel,
                    "cerebras" => request.CerebrasModel,
                    "copilot" => request.CopilotModel,
                    "codex" => request.CodexModel,
                    _ => null
                }
            );
            var providerPrepared = await PrepareInputForProviderAsync(
                contextualInput,
                provider,
                model,
                request.Attachments,
                request.WebUrls,
                request.WebSearchEnabled,
                false,
                cancellationToken
            );
            if (!string.IsNullOrWhiteSpace(providerPrepared.UnsupportedMessage))
            {
                workerTaskList.Add(Task.FromResult(BuildUnsupportedCodingWorkerResult(
                    provider,
                    model,
                    request.Language,
                    providerPrepared.UnsupportedMessage
                )));
                continue;
            }

            var prompt = BuildCodingAgentObjectivePrompt(providerPrepared.Text, request.Language, "다중 코딩");
            workerTaskList.Add(RunCodingWorkerAsync(
                provider,
                model,
                prompt,
                request.Language,
                cancellationToken,
                progressCallback,
                "multi-worker"
            ));
        }
        var workerTasks = workerTaskList.ToArray();
        await Task.WhenAll(workerTasks);

        var workerResults = workerTasks.Select(x => x.Result).ToArray();
        var availabilityByProvider = await GetProviderAvailabilityMapAsync(cancellationToken);
        var selectionByProvider = BuildProviderSelectionMap(
            request.GroqModel,
            request.GeminiModel,
            request.CerebrasModel,
            request.CopilotModel,
            request.CodexModel
        );
        var workerChatResults = workerResults
            .Select(x => new LlmSingleChatResult(x.Provider, x.Model, x.RawResponse))
            .ToArray();
        var successfulWorkers = workerChatResults
            .Where(x => IsUsableWorkerResult(x, availabilityByProvider, selectionByProvider))
            .ToArray();
        var requestedSummaryProvider = NormalizeProvider(request.Provider, allowAuto: true);
        var resolvedSummaryProvider = ResolveProviderForAggregation(
            requestedSummaryProvider,
            successfulWorkers,
            availabilityByProvider,
            selectionByProvider,
            allowProviderWithoutWorkerFallback: false
        );

        var summaryPrompt = BuildMultiCodingSummaryPrompt(rawInput, workerResults);
        var summaryModel = "-";
        string summaryText;
        if (resolvedSummaryProvider == "none")
        {
            summaryText = "요약: 사용 가능한 LLM이 없어 자동 요약을 건너뜁니다.";
        }
        else
        {
            var summaryModelOverride = request.Model;
            if (string.IsNullOrWhiteSpace(summaryModelOverride))
            {
                summaryModelOverride = resolvedSummaryProvider switch
                {
                    "groq" => request.GroqModel,
                    "gemini" => request.GeminiModel,
                    "cerebras" => request.CerebrasModel,
                    "copilot" => request.CopilotModel,
                    "codex" => request.CodexModel,
                    _ => null
                };
            }

            summaryModel = ResolveModel(resolvedSummaryProvider, summaryModelOverride);
            var summary = await GenerateByProviderSafeAsync(
                resolvedSummaryProvider,
                summaryModel,
                summaryPrompt,
                cancellationToken,
                _config.CodingMaxOutputTokens
            );
            summaryText = SanitizeChatOutput(summary.Text);
        }

        var citationBundleMulti = BuildAndLogCitationMappings(
            request.Source,
            "coding-multi",
            sharedPrepared.Citations,
            ("summary", summaryText)
        );
        var citationValidationGuardFailure = BuildCitationValidationGuardFailure(citationBundleMulti.Validation);
        var effectiveGuardFailure = sharedPrepared.GuardFailure ?? citationValidationGuardFailure;
        var responseSummary = summaryText;
        var representative = workerResults.FirstOrDefault(x => x.Execution.Status == "ok") ?? workerResults[0];
        var assistantText = BuildMultiCodingAssistantText(workerResults, responseSummary);
        if (citationValidationGuardFailure is not null)
        {
            LogCitationValidationGuardBlocked(request.Source, "coding-multi", citationValidationGuardFailure);
            responseSummary = BuildCitationValidationBlockedResponseText(citationValidationGuardFailure);
            assistantText = responseSummary;
        }
        _conversationStore.AppendMessage(thread.Id, "user", rawInput, "coding-multi");
        _conversationStore.AppendMessage(thread.Id, "assistant", assistantText, $"coding-multi:summary={resolvedSummaryProvider}:{summaryModel}");
        await EnsureConversationTitleFromFirstTurnAsync(thread.Id, resolvedSummaryProvider, summaryModel, cancellationToken);

        var note = await MaybeCompressConversationAsync(
            thread.Id,
            $"{session.Scope}-{session.Mode}",
            resolvedSummaryProvider,
            summaryModel,
            cancellationToken
        );
        var updated = _conversationStore.Get(thread.Id) ?? thread;
        var mergedChangedFiles = workerResults
            .SelectMany(x => x.ChangedFiles)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return new CodingRunResult(
            "multi",
            updated.Id,
            resolvedSummaryProvider,
            summaryModel,
            representative.Language,
            representative.Code,
            representative.Execution,
            workerResults,
            mergedChangedFiles,
            responseSummary,
            updated,
            note,
            effectiveGuardFailure,
            sharedPrepared.Citations,
            citationBundleMulti.Mappings,
            citationBundleMulti.Validation,
            sharedPrepared.RetryAttempt,
            sharedPrepared.RetryMaxAttempts,
            sharedPrepared.RetryStopReason
        );
    }

    private static string BuildAutoOrchestrationCodingInput(string language)
    {
        var targetLanguage = string.IsNullOrWhiteSpace(language) ? "auto" : language;
        return $"""
                [자동 오케스트레이션 코딩 모드]
                사용자가 입력 없이 실행했습니다.
                워커 모델들이 역할을 스스로 협의해 작업을 분배하고 병렬 실행하세요.
                목표:
                1) 워크스페이스를 점검하고 실행 가능한 개선 작업 1건 수행
                2) 변경 파일 생성/수정
                3) 실행/검증 후 결과 요약
                언어 힌트: {targetLanguage}
                """;
    }

    private static Dictionary<string, string> BuildDefaultOrchestrationRoles(IReadOnlyList<string> providers)
    {
        var roles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["copilot"] = "코드 생성/수정 담당. 바로 실행 가능한 코드/패치를 우선 제시하세요.",
            ["codex"] = "정밀 구현/검증 담당. 요구사항 누락 없이 완성도 높은 해법을 제시하세요.",
            ["gemini"] = "리뷰/설계 검증 담당. 버그 원인, 예외, 트레이드오프를 점검하세요.",
            ["groq"] = "빠른 보조 담당. 로그 해석, 대안 아이디어, 빠른 수정 포인트를 제시하세요."
        };

        return providers
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                provider => provider,
                provider => roles.TryGetValue(provider, out var role)
                    ? role
                    : "구현자. 동작 코드 중심으로 작성하세요.",
                StringComparer.OrdinalIgnoreCase
            );
    }

    private async Task<Dictionary<string, string>> NegotiateOrchestrationRolesAsync(
        IReadOnlyList<string> providers,
        IReadOnlyDictionary<string, string> modelByProvider,
        string contextualInput,
        string language,
        CancellationToken cancellationToken
    )
    {
        var defaults = BuildDefaultOrchestrationRoles(providers);
        if (providers.Count <= 1)
        {
            return defaults;
        }

        var providerList = string.Join(", ", providers);
        var proposalTasks = providers.ToDictionary(
            provider => provider,
            provider =>
            {
                var model = modelByProvider[provider];
                var prompt = $"""
                              자동 오케스트레이션 코딩의 역할 협의 단계입니다.
                              참여 워커: {providerList}
                              너의 워커: {provider}
                              목표 요약:
                              {contextualInput}

                              언어 힌트: {language}
                              다른 워커와 중복을 최소화하는 "내 역할"을 1문장으로 제안하세요.
                              출력 형식:
                              역할: <한 문장>
                              """;
                return GenerateByProviderSafeAsync(provider, model, prompt, cancellationToken, 180);
            },
            StringComparer.OrdinalIgnoreCase
        );
        await Task.WhenAll(proposalTasks.Values);

        var proposalLines = new List<string>();
        foreach (var provider in providers)
        {
            var text = SanitizeChatOutput(proposalTasks[provider].Result.Text);
            var role = ExtractNegotiatedRoleText(text);
            if (string.IsNullOrWhiteSpace(role))
            {
                role = defaults[provider];
            }

            proposalLines.Add($"{provider}: {role}");
        }

        var mediator = providers.Contains("gemini", StringComparer.OrdinalIgnoreCase)
            ? "gemini"
            : providers.Contains("groq", StringComparer.OrdinalIgnoreCase)
                ? "groq"
                : providers[0];
        var mediatorModel = modelByProvider[mediator];
        var mergePrompt = $"""
                           아래는 워커별 역할 제안입니다.
                           {string.Join("\n", proposalLines)}

                           참여 워커: {providerList}
                           역할이 겹치지 않게 최종 배분을 확정하세요.
                           출력 형식(줄 단위):
                           provider: role
                           예시:
                           copilot: 코드 생성
                           gemini: 설계 검증
                           groq: 로그/실행 보조
                           """;
        var merged = await GenerateByProviderSafeAsync(mediator, mediatorModel, mergePrompt, cancellationToken, 260);
        var mergedText = SanitizeChatOutput(merged.Text);
        var resolved = ParseNegotiatedRoleAssignments(mergedText, providers);
        if (resolved.Count == 0)
        {
            resolved = proposalLines
                .Select(line =>
                {
                    var split = line.Split(':', 2);
                    return (Provider: split[0].Trim(), Role: split.Length > 1 ? split[1].Trim() : string.Empty);
                })
                .Where(item => !string.IsNullOrWhiteSpace(item.Provider))
                .ToDictionary(item => item.Provider, item => item.Role, StringComparer.OrdinalIgnoreCase);
        }

        foreach (var provider in providers)
        {
            if (!resolved.TryGetValue(provider, out var role) || string.IsNullOrWhiteSpace(role))
            {
                resolved[provider] = defaults[provider];
            }
        }

        return resolved;
    }

    private static string ExtractNegotiatedRoleText(string text)
    {
        var cleaned = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(cleaned))
        {
            return string.Empty;
        }

        var lines = cleaned
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var line in lines)
        {
            var normalized = line.Trim().TrimStart('-', '*', '#', ' ');
            if (normalized.StartsWith("역할:", StringComparison.OrdinalIgnoreCase))
            {
                var role = normalized[3..].Trim();
                if (!string.IsNullOrWhiteSpace(role))
                {
                    return role;
                }
            }

            if (normalized.StartsWith("role:", StringComparison.OrdinalIgnoreCase))
            {
                var role = normalized[5..].Trim();
                if (!string.IsNullOrWhiteSpace(role))
                {
                    return role;
                }
            }
        }

        return lines.Length == 0 ? string.Empty : lines[0];
    }

    private static Dictionary<string, string> ParseNegotiatedRoleAssignments(string text, IReadOnlyList<string> providers)
    {
        var known = providers.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var lines = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim().TrimStart('-', '*', '#', ' ');
            var split = line.Split(':', 2, StringSplitOptions.TrimEntries);
            if (split.Length < 2)
            {
                continue;
            }

            var provider = split[0].Trim().ToLowerInvariant();
            if (!known.Contains(provider))
            {
                continue;
            }

            var role = split[1].Trim();
            if (!string.IsNullOrWhiteSpace(role))
            {
                map[provider] = role;
            }
        }

        return map;
    }
}
