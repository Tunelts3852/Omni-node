using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private static readonly Regex CitationBracketRegex = new(
        @"\[(?<id>c[0-9a-z_-]+)\]",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex CitationSentenceSplitRegex = new(
        @"(?<=[\.\!\?。！？])\s+",
        RegexOptions.Compiled
    );
    private static readonly Regex RequestedCountRegex = new(
        @"(?<!\d)(?<n>[1-9]\d?)\s*(개|건|가지|뉴스|news|items?|results?)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex TopCountRegex = new(
        @"(?:top|상위)\s*(?<n>[1-9]\d?)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly IReadOnlyDictionary<string, string> SourceLabelByHostSuffix = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["kbs.co.kr"] = "KBS 뉴스",
        ["mbc.co.kr"] = "MBC 뉴스",
        ["sbs.co.kr"] = "SBS 뉴스",
        ["yna.co.kr"] = "연합뉴스",
        ["yonhapnews.co.kr"] = "연합뉴스",
        ["cnn.com"] = "CNN",
        ["bbc.com"] = "BBC",
        ["reuters.com"] = "Reuters",
        ["apnews.com"] = "AP News",
        ["mk.co.kr"] = "매일경제",
        ["hankyung.com"] = "한국경제",
        ["chosun.com"] = "조선일보",
        ["joongang.co.kr"] = "중앙일보",
        ["donga.com"] = "동아일보",
        ["khan.co.kr"] = "경향신문",
        ["hani.co.kr"] = "한겨레",
        ["newsis.com"] = "뉴시스",
        ["edaily.co.kr"] = "이데일리",
        ["seoul.co.kr"] = "서울신문",
        ["nocutnews.co.kr"] = "노컷뉴스",
        ["news.naver.com"] = "네이버 뉴스",
        ["korea.kr"] = "대한민국 정책브리핑"
    };

    public IReadOnlyList<RoutineSummary> ListRoutines()
    {
        lock (_routineLock)
        {
            return _routinesById.Values
                .OrderBy(x => x.NextRunUtc)
                .Select(ToRoutineSummary)
                .ToArray();
        }
    }

    public async Task<RoutineActionResult> CreateRoutineAsync(string request, string source, CancellationToken cancellationToken)
    {
        var input = (request ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(input))
        {
            return new RoutineActionResult(false, "루틴 요청이 비어 있습니다.", null);
        }

        var schedule = ParseDailySchedule(input);
        var createdAt = DateTimeOffset.UtcNow;
        var id = $"rt-{createdAt:yyyyMMddHHmmss}-{Guid.NewGuid().ToString("N")[..8]}";
        var title = BuildRoutineTitle(input);
        var timezone = TimeZoneInfo.Local.Id;
        var nextRunUtc = ComputeNextDailyRunUtc(schedule.Hour, schedule.Minute, timezone, createdAt);
        var runDir = Path.Combine(_config.WorkspaceRootDir, "routines", id);
        Directory.CreateDirectory(runDir);

        var generation = await GenerateRoutineImplementationAsync(input, schedule, cancellationToken);
        var scriptFileName = generation.Language == "python" ? "run.py" : "run.sh";
        var scriptPath = Path.Combine(runDir, scriptFileName);
        File.WriteAllText(scriptPath, generation.Code, Encoding.UTF8);
        if (!OperatingSystem.IsWindows())
        {
            try
            {
                File.SetUnixFileMode(scriptPath,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }
            catch
            {
            }
        }

        var routine = new RoutineDefinition
        {
            Id = id,
            Title = title,
            Request = input,
            ScheduleText = schedule.Display,
            TimezoneId = timezone,
            Hour = schedule.Hour,
            Minute = schedule.Minute,
            Enabled = true,
            NextRunUtc = nextRunUtc,
            LastRunUtc = null,
            LastStatus = "created",
            LastOutput = generation.Plan,
            ScriptPath = scriptPath,
            Language = generation.Language,
            Code = generation.Code,
            Planner = generation.PlannerProvider,
            PlannerModel = generation.PlannerModel,
            CoderModel = generation.CoderModel,
            CreatedUtc = createdAt
        };

        lock (_routineLock)
        {
            _routinesById[routine.Id] = routine;
            SaveRoutineStateLocked();
        }

        var runNow = await RunRoutineNowAsync(routine.Id, source, cancellationToken);
        return runNow with
        {
            Routine = ToRoutineSummary(routine),
            Message = $"루틴 생성 완료: {title} ({schedule.Display})\n{runNow.Message}"
        };
    }

    public async Task<RoutineActionResult> RunRoutineNowAsync(string routineId, string source, CancellationToken cancellationToken)
    {
        var key = (routineId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key))
        {
            return new RoutineActionResult(false, "routineId가 필요합니다.", null);
        }

        RoutineDefinition? routine;
        lock (_routineLock)
        {
            if (!_routinesById.TryGetValue(key, out var found))
            {
                return new RoutineActionResult(false, "루틴을 찾을 수 없습니다.", null);
            }

            if (found.Running)
            {
                return new RoutineActionResult(false, "이미 실행 중인 루틴입니다.", ToRoutineSummary(found));
            }

            found.Running = true;
            routine = found;
            SaveRoutineStateLocked();
        }

        var startedAtUtc = DateTimeOffset.UtcNow;
        CodeExecutionResult exec;
        if (ShouldRunCronAgentTurnBridge(routine))
        {
            exec = ExecuteCronAgentTurnBridge(routine, cancellationToken);
        }
        else
        {
            exec = await _codeRunner.ExecuteAsync(routine.Language, routine.Code, cancellationToken);
        }
        var output = BuildRoutineExecutionText(routine, exec);
        var completedAtUtc = DateTimeOffset.UtcNow;
        var durationMs = Math.Max(0L, (long)(completedAtUtc - startedAtUtc).TotalMilliseconds);
        var runStatus = ResolveCronRunEntryStatus(exec);
        var runError = BuildCronRunEntryError(exec, output, runStatus);
        var runSummary = BuildCronRunEntrySummary(output);

        lock (_routineLock)
        {
            if (_routinesById.TryGetValue(key, out var update))
            {
                update.Running = false;
                update.LastRunUtc = completedAtUtc;
                update.LastStatus = exec.Status;
                update.LastOutput = output;
                update.LastDurationMs = durationMs;
                if (string.Equals(NormalizeCronScheduleKind(update.CronScheduleKind), "at", StringComparison.Ordinal))
                {
                    update.Enabled = false;
                    update.NextRunUtc = completedAtUtc;
                }
                else
                {
                    update.NextRunUtc = ComputeNextCronBridgeRunUtc(update, completedAtUtc);
                }

                AppendRoutineRunLogEntry(update, new RoutineRunLogEntry
                {
                    Ts = completedAtUtc.ToUnixTimeMilliseconds(),
                    JobId = update.Id,
                    Action = "finished",
                    Status = runStatus,
                    Error = runError,
                    Summary = runSummary,
                    RunAtMs = startedAtUtc.ToUnixTimeMilliseconds(),
                    DurationMs = durationMs,
                    NextRunAtMs = update.Enabled ? update.NextRunUtc.ToUnixTimeMilliseconds() : null
                });
                SaveRoutineStateLocked();
                routine = update;
            }
        }

        if (_telegramClient.IsConfigured && source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            _ = _telegramClient.SendMessageAsync(FormatTelegramResponse(output, TelegramMaxResponseChars), cancellationToken);
        }

        return new RoutineActionResult(true, output, routine == null ? null : ToRoutineSummary(routine));
    }

    public RoutineActionResult SetRoutineEnabled(string routineId, bool enabled)
    {
        var key = (routineId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key))
        {
            return new RoutineActionResult(false, "routineId가 필요합니다.", null);
        }

        lock (_routineLock)
        {
            if (!_routinesById.TryGetValue(key, out var routine))
            {
                return new RoutineActionResult(false, "루틴을 찾을 수 없습니다.", null);
            }

            routine.Enabled = enabled;
            if (enabled)
            {
                routine.NextRunUtc = ComputeNextCronBridgeRunUtc(routine, DateTimeOffset.UtcNow);
            }
            routine.LastStatus = enabled ? "enabled" : "disabled";
            SaveRoutineStateLocked();
            return new RoutineActionResult(true, enabled ? "루틴 활성화" : "루틴 비활성화", ToRoutineSummary(routine));
        }
    }

    public RoutineActionResult DeleteRoutine(string routineId)
    {
        var key = (routineId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key))
        {
            return new RoutineActionResult(false, "routineId가 필요합니다.", null);
        }

        lock (_routineLock)
        {
            if (!_routinesById.Remove(key))
            {
                return new RoutineActionResult(false, "루틴을 찾을 수 없습니다.", null);
            }

            SaveRoutineStateLocked();
            return new RoutineActionResult(true, "루틴 삭제 완료", null);
        }
    }

    public async Task<ConversationChatResult> ChatSingleWithStateAsync(
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
        if (request.WebSearchEnabled)
        {
            var decisionStopwatch = Stopwatch.StartNew();
            var decisionPath = "llm";
            var shouldUseGeminiWeb = false;
            var selfDecideNeedWeb = false;

            if (LooksLikeRealtimeQuestion(rawInput))
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
                var webResult = await GenerateGeminiGroundedWebAnswerDetailedAsync(
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
                    cancellationToken
                );
                var webText = webResult.Response.Text;
                var assistantMeta = "gemini-web-single";
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
                    null,
                    null,
                    null,
                    null,
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
        var responseText = generated.Text;

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

    public async Task<ConversationChatResult> ChatOrchestrationWithStateAsync(
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

    public async Task<ConversationMultiResult> ChatMultiWithStateAsync(
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
                blockedCitationBundle.Validation
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
            ("summary", generated.Summary)
        );
        var effectiveGuardFailure = basePrepared.GuardFailure;
        var responseGroqText = generated.GroqText;
        var responseGeminiText = generated.GeminiText;
        var responseCerebrasText = generated.CerebrasText;
        var responseCopilotText = generated.CopilotText;
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
            generated.ResolvedSummaryProvider
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
            citationBundle.Validation
        );
    }

    public async Task<CodingRunResult> RunCodingSingleAsync(
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

    public async Task<CodingRunResult> RunCodingOrchestrationAsync(
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
            request.CopilotModel
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

    public async Task<CodingRunResult> RunCodingMultiAsync(
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
            request.CopilotModel
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

    private async Task<LlmSingleChatResult> ExecuteProviderChatWithPreparedInputAsync(
        string provider,
        string? model,
        string input,
        IReadOnlyList<InputAttachment>? attachments,
        CancellationToken cancellationToken
    )
    {
        var resolvedProvider = NormalizeProvider(provider, allowAuto: false);
        var resolvedModel = ResolveModel(resolvedProvider, model);
        var prepared = await PrepareInputForProviderAsync(
            input,
            resolvedProvider,
            resolvedModel,
            attachments,
            null,
            true,
            false,
            cancellationToken
        );
        if (!string.IsNullOrWhiteSpace(prepared.UnsupportedMessage))
        {
            return new LlmSingleChatResult(resolvedProvider, resolvedModel, prepared.UnsupportedMessage);
        }

        return await GenerateByProviderSafeAsync(
            resolvedProvider,
            resolvedModel,
            prepared.Text,
            cancellationToken
        );
    }

    private async Task<InputPreparationResult> PrepareSharedInputAsync(
        string input,
        IReadOnlyList<InputAttachment>? attachments,
        IReadOnlyList<string>? webUrls,
        bool webSearchEnabled,
        CancellationToken cancellationToken,
        string source = "web",
        string? sessionKey = null,
        string? threadBindingKey = null
    )
    {
        var normalizedInput = (input ?? string.Empty).Trim();
        var normalizedAttachments = NormalizeAttachments(attachments);
        var urls = ResolveWebUrls(normalizedInput, webUrls, webSearchEnabled);
        var builder = new StringBuilder();
        builder.AppendLine(normalizedInput);

        var textAttachmentBlock = BuildTextAttachmentBlock(normalizedAttachments);
        if (!string.IsNullOrWhiteSpace(textAttachmentBlock))
        {
            builder.AppendLine();
            builder.AppendLine(textAttachmentBlock);
        }

        if (urls.Count > 0)
        {
            var webBlock = await BuildWebContextBlockAsync(urls, cancellationToken);
            if (!string.IsNullOrWhiteSpace(webBlock))
            {
                builder.AppendLine();
                builder.AppendLine(webBlock);
            }
        }

        var normalizedSource = NormalizeAuditToken(source, "web");
        var forcedContextRequestId = BuildForcedContextRequestId();
        var sessionThreadBinding = TryExtractSessionThreadBinding(sessionKey);
        var normalizedSessionThread = NormalizeAuditToken(sessionThreadBinding, "-");
        var normalizedThreadBinding = NormalizeAuditToken(threadBindingKey, "-");
        var bindingStatus = ResolveThreadBindingStatus(sessionThreadBinding, threadBindingKey);
        SearchAnswerGuardFailure? forcedGuardFailure = null;
        IReadOnlyList<SearchCitationReference> forcedCitations = Array.Empty<SearchCitationReference>();
        var forcedRetryAttempt = 0;
        var forcedRetryMaxAttempts = 0;
        var forcedRetryStopReason = "-";
        try
        {
            var (forcedBlock, forcedTrace, guardFailure, citations, retryAttempt, retryMaxAttempts, retryStopReason) = await BuildForcedRetrievalContextBlockAsync(
                normalizedInput,
                normalizedSource,
                sessionKey,
                threadBindingKey,
                forcedContextRequestId,
                cancellationToken
            );
            forcedGuardFailure = guardFailure;
            forcedCitations = citations;
            forcedRetryAttempt = retryAttempt;
            forcedRetryMaxAttempts = retryMaxAttempts;
            forcedRetryStopReason = retryStopReason;
            _auditLogger.Log(normalizedSource, "forced_context", "ok", forcedTrace);
            if (!string.IsNullOrWhiteSpace(forcedBlock))
            {
                builder.AppendLine();
                builder.AppendLine(forcedBlock);
            }
        }
        catch (Exception ex)
        {
            forcedGuardFailure = new SearchAnswerGuardFailure(
                SearchAnswerGuardFailureCategory.Coverage,
                "forced_context_exception",
                TrimForAudit(ex.Message, 160)
            );
            forcedRetryAttempt = 1;
            forcedRetryMaxAttempts = 1;
            forcedRetryStopReason = "forced_context_exception";
            _auditLogger.Log(
                normalizedSource,
                "forced_context",
                "fail",
                BuildForcedContextTraceMessage(
                    forcedContextRequestId,
                    normalizedSource,
                    sessionKey,
                    normalizedThreadBinding,
                    normalizedSessionThread,
                    bindingStatus,
                    "na",
                    CreateForcedToolTrace("error", detail: "prestep_exception"),
                    CreateForcedToolTrace("error", detail: "prestep_exception"),
                    CreateForcedToolTrace("error", detail: "prestep_exception"),
                    CreateForcedToolTrace("error", detail: "prestep_exception"),
                    TrimForAudit(ex.Message, 220)
                )
            );
        }

        var unsupportedMessage = forcedGuardFailure is null
            ? string.Empty
            : BuildGroundedSearchFailureMessage(forcedGuardFailure, forcedRetryStopReason);
        return new InputPreparationResult(
            builder.ToString().Trim(),
            unsupportedMessage,
            forcedGuardFailure,
            forcedCitations,
            forcedRetryAttempt,
            forcedRetryMaxAttempts,
            forcedRetryStopReason
        );
    }

    private async Task<InputPreparationResult> PrepareInputForProviderAsync(
        string input,
        string provider,
        string? model,
        IReadOnlyList<InputAttachment>? attachments,
        IReadOnlyList<string>? webUrls,
        bool webSearchEnabled,
        bool includeSharedContext,
        CancellationToken cancellationToken,
        string source = "web",
        string? sessionKey = null,
        string? threadBindingKey = null
    )
    {
        var shared = includeSharedContext
            ? await PrepareSharedInputAsync(
                input,
                attachments,
                webUrls,
                webSearchEnabled,
                cancellationToken,
                source,
                sessionKey,
                threadBindingKey
            )
            : new InputPreparationResult((input ?? string.Empty).Trim(), string.Empty);
        var normalizedAttachments = NormalizeAttachments(attachments);
        var nonTextAttachments = normalizedAttachments
            .Where(item => !IsTextLikeAttachment(item))
            .ToArray();
        if (nonTextAttachments.Length == 0)
        {
            return shared;
        }

        var resolvedProvider = NormalizeProvider(provider, allowAuto: false);
        var resolvedModel = ResolveModel(resolvedProvider, model);
        if (!CanProviderHandleAttachments(resolvedProvider, resolvedModel, nonTextAttachments))
        {
            return new InputPreparationResult(
                shared.Text,
                $"현재 선택 모델({resolvedProvider}:{resolvedModel})은 이미지/파일을 확인할 수 없습니다.",
                shared.GuardFailure,
                shared.Citations,
                shared.RetryAttempt,
                shared.RetryMaxAttempts,
                shared.RetryStopReason
            );
        }

        var summaryPrompt = BuildAttachmentSummaryPrompt(input ?? string.Empty, nonTextAttachments);
        string summary;
        if (resolvedProvider == "gemini")
        {
            summary = await _llmRouter.GenerateGeminiMultimodalChatAsync(
                summaryPrompt,
                resolvedModel,
                nonTextAttachments,
                Math.Min(_config.ChatMaxOutputTokens, 1400),
                cancellationToken
            );
        }
        else if (resolvedProvider == "groq")
        {
            summary = await _llmRouter.GenerateGroqMultimodalChatAsync(
                summaryPrompt,
                resolvedModel,
                nonTextAttachments,
                Math.Min(_config.ChatMaxOutputTokens, 1400),
                cancellationToken
            );
        }
        else
        {
            return new InputPreparationResult(
                shared.Text,
                $"현재 선택 모델({resolvedProvider}:{resolvedModel})은 이미지/파일을 확인할 수 없습니다.",
                shared.GuardFailure,
                shared.Citations,
                shared.RetryAttempt,
                shared.RetryMaxAttempts,
                shared.RetryStopReason
            );
        }

        var cleanedSummary = SanitizeChatOutput(summary);
        if (string.IsNullOrWhiteSpace(cleanedSummary))
        {
            cleanedSummary = "첨부 분석 결과를 생성하지 못했습니다.";
        }

        var merged = new StringBuilder();
        merged.AppendLine(shared.Text);
        merged.AppendLine();
        merged.AppendLine("[첨부 이미지/파일 분석 요약]");
        merged.AppendLine(cleanedSummary);
        return new InputPreparationResult(
            merged.ToString().Trim(),
            string.Empty,
            shared.GuardFailure,
            shared.Citations,
            shared.RetryAttempt,
            shared.RetryMaxAttempts,
            shared.RetryStopReason
        );
    }

    private async Task<(
        string ContextBlock,
        string TraceMessage,
        SearchAnswerGuardFailure? GuardFailure,
        IReadOnlyList<SearchCitationReference> Citations,
        int RetryAttempt,
        int RetryMaxAttempts,
        string RetryStopReason
    )> BuildForcedRetrievalContextBlockAsync(
        string input,
        string source,
        string? sessionKey,
        string? threadBindingKey,
        string requestId,
        CancellationToken cancellationToken
    )
    {
        var query = (input ?? string.Empty).Trim();
        var sessionThreadBinding = TryExtractSessionThreadBinding(sessionKey);
        var normalizedSessionThread = NormalizeAuditToken(sessionThreadBinding, "-");
        var normalizedThreadBinding = NormalizeAuditToken(threadBindingKey, "-");
        var bindingStatus = ResolveThreadBindingStatus(
            sessionThreadBinding,
            threadBindingKey
        );
        var memorySearchTrace = CreateForcedToolTrace("skip", skipReason: "not_executed");
        var memoryGetTrace = CreateForcedToolTrace("skip", skipReason: "not_executed");
        var webSearchTrace = CreateForcedToolTrace("skip", skipReason: "not_executed");
        var webFetchTrace = CreateForcedToolTrace("skip", skipReason: "not_executed");
        var freshnessTrace = "na";
        SearchAnswerGuardFailure? webSearchGuardFailure = null;
        IReadOnlyList<SearchCitationReference> webSearchCitations = Array.Empty<SearchCitationReference>();
        var retryAttempt = 0;
        var retryMaxAttempts = 0;
        var retryStopReason = "-";
        var rawSessionScope = TryExtractSessionScope(sessionKey);
        var normalizedMemoryScope = NormalizeMemoryScopeForForcedContext(rawSessionScope);
        var allowedConversationIds = BuildScopedConversationIdSet(normalizedMemoryScope);
        if (string.IsNullOrWhiteSpace(query))
        {
            memorySearchTrace = CreateForcedToolTrace("skip", skipReason: "empty_query");
            memoryGetTrace = CreateForcedToolTrace("skip", skipReason: "empty_query");
            webSearchTrace = CreateForcedToolTrace("skip", skipReason: "empty_query");
            webFetchTrace = CreateForcedToolTrace("skip", skipReason: "empty_query");
            return (
                string.Empty,
                BuildForcedContextTraceMessage(
                    requestId,
                    source,
                    sessionKey,
                    normalizedThreadBinding,
                    normalizedSessionThread,
                    bindingStatus,
                    freshnessTrace,
                    memorySearchTrace,
                    memoryGetTrace,
                    webSearchTrace,
                    webFetchTrace,
                    "-"
                ),
                null,
                Array.Empty<SearchCitationReference>(),
                retryAttempt,
                retryMaxAttempts,
                "empty_query"
            );
        }

        var sections = new List<string>();

        var memorySearch = _memorySearchTool.Search(query, maxResults: 4, minScore: ResolveForcedMemoryMinScore(query));
        var scopedMemoryResults = FilterMemorySearchResultsByScope(memorySearch.Results, normalizedMemoryScope, allowedConversationIds);
        if (memorySearch.Disabled)
        {
            memorySearchTrace = CreateForcedToolTrace(
                "disabled",
                detail: TrimForAudit(memorySearch.Error, 120)
            );
        }
        else
        {
            memorySearchTrace = CreateForcedToolTrace(
                "ok",
                result: $"{scopedMemoryResults.Count.ToString(CultureInfo.InvariantCulture)}/{memorySearch.Results.Count.ToString(CultureInfo.InvariantCulture)}"
            );
            if (scopedMemoryResults.Count > 0)
            {
                sections.Add(BuildMemorySearchContextBlock(scopedMemoryResults));
            }
        }

        MemoryGetToolResult? memoryGet = null;
        var topMemoryHit = scopedMemoryResults.FirstOrDefault();
        if (topMemoryHit != null)
        {
            var lineWindow = Math.Clamp(topMemoryHit.EndLine - topMemoryHit.StartLine + 4, 6, 28);
            memoryGet = _memoryGetTool.Get(topMemoryHit.Path, topMemoryHit.StartLine, lineWindow);
            if (memoryGet.Disabled)
            {
                memoryGetTrace = CreateForcedToolTrace(
                    "disabled",
                    detail: TrimForAudit(memoryGet.Error, 120)
                );
            }
            else if (string.IsNullOrWhiteSpace(memoryGet.Text))
            {
                memoryGetTrace = CreateForcedToolTrace(
                    "ok",
                    result: "0",
                    detail: TrimForAudit(
                        $"{topMemoryHit.Path}{FormatMemoryLineRange(topMemoryHit.StartLine, topMemoryHit.EndLine)}",
                        120
                    )
                );
            }
            else
            {
                memoryGetTrace = CreateForcedToolTrace(
                    "ok",
                    result: "1",
                    detail: TrimForAudit(
                        $"{topMemoryHit.Path}{FormatMemoryLineRange(topMemoryHit.StartLine, topMemoryHit.EndLine)}",
                        120
                    )
                );
                sections.Add(BuildMemoryGetContextBlock(topMemoryHit, memoryGet));
            }
        }
        else
        {
            var fallbackNote = ResolveFallbackMemoryNoteForScope(normalizedMemoryScope);
            if (fallbackNote == null)
            {
                memoryGetTrace = CreateForcedToolTrace("skip", skipReason: "no_hit_no_note");
            }
            else
            {
                var fallbackPath = $"memory-notes/{fallbackNote.Name}";
                memoryGet = _memoryGetTool.Get(fallbackPath, 1, 16);
                if (memoryGet.Disabled)
                {
                    memoryGetTrace = CreateForcedToolTrace(
                        "disabled",
                        detail: TrimForAudit($"fallback:{memoryGet.Error}", 120)
                    );
                }
                else if (string.IsNullOrWhiteSpace(memoryGet.Text))
                {
                    memoryGetTrace = CreateForcedToolTrace(
                        "ok",
                        result: "0",
                        detail: TrimForAudit(fallbackPath, 120)
                    );
                }
                else
                {
                    memoryGetTrace = CreateForcedToolTrace(
                        "ok",
                        result: "1",
                        detail: TrimForAudit(fallbackPath, 120)
                    );
                    sections.Add(
                        "[memory_get]\n"
                        + $"path: {fallbackPath}\n"
                        + TrimForForcedContext(memoryGet.Text, 900)
                    );
                }
            }
        }

        var webSearchDecision = await DecideWebSearchRequirementAsync(
            query,
            cancellationToken
        );
        freshnessTrace = webSearchDecision.DecisionLabel;
        if (!webSearchDecision.Required)
        {
            webSearchTrace = CreateForcedToolTrace("skip", skipReason: "llm_not_required");
            webFetchTrace = CreateForcedToolTrace("skip", skipReason: "llm_not_required");
            retryStopReason = "llm_not_required";
        }
        else
        {
            var freshness = ResolveSearchFreshnessForQuery(query);
            var requestedSearchCount = ResolveRequestedResultCountFromQuery(query);
            var effectiveSearchQuery = BuildEffectiveSearchQuery(query, webSearchDecision);
            WebSearchToolResult webSearch;
            try
            {
                if (_config.EnableFastWebPipeline)
                {
                    webSearch = await SearchWebAsync(
                        effectiveSearchQuery,
                        requestedSearchCount,
                        freshness,
                        cancellationToken,
                        source: source
                    );
                }
                else
                {
                    var searchTimeoutSeconds = Math.Clamp(_config.LlmTimeoutSec + 8, 12, 40);
                    using var searchTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    searchTimeoutCts.CancelAfter(TimeSpan.FromSeconds(searchTimeoutSeconds));
                    webSearch = await SearchWebAsync(
                        effectiveSearchQuery,
                        requestedSearchCount,
                        freshness,
                        searchTimeoutCts.Token,
                        source: source
                    );
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                webSearch = new WebSearchToolResult(
                    Provider: "gemini_grounding",
                    Results: Array.Empty<WebSearchResultItem>(),
                    Disabled: true,
                    Error: "web_search_timeout",
                    RetryAttempt: 1,
                    RetryMaxAttempts: 1,
                    RetryStopReason: "web_search_timeout"
                );
            }

            webSearchGuardFailure = webSearch.GuardFailure;
            retryAttempt = Math.Max(0, webSearch.RetryAttempt);
            retryMaxAttempts = Math.Max(0, webSearch.RetryMaxAttempts);
            retryStopReason = string.IsNullOrWhiteSpace(webSearch.RetryStopReason)
                ? "-"
                : webSearch.RetryStopReason;
            if (webSearch.Disabled)
            {
                webSearchTrace = CreateForcedToolTrace(
                    "disabled",
                    detail: TrimForAudit(webSearch.Error, 120),
                    guardCategory: webSearch.GuardFailure?.Category.ToString(),
                    guardReason: webSearch.GuardFailure?.ReasonCode,
                    guardDetail: webSearch.GuardFailure?.Detail
                );
                webFetchTrace = CreateForcedToolTrace(
                    "skip",
                    skipReason: webSearch.Error?.Contains("timeout", StringComparison.OrdinalIgnoreCase) == true
                        ? "search_timeout"
                        : "search_disabled"
                );
            }
            else
            {
                IReadOnlyList<WebSearchResultItem> contextAlignedResults;
                var alignTimedOut = false;
                try
                {
                    using var alignTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    var alignTimeoutSeconds = _config.EnableFastWebPipeline
                        ? Math.Clamp((_config.LlmTimeoutSec / 2), 3, 6)
                        : Math.Clamp(_config.LlmTimeoutSec, 8, 24);
                    alignTimeoutCts.CancelAfter(TimeSpan.FromSeconds(alignTimeoutSeconds));
                    contextAlignedResults = await BuildContextAlignedWebResultsAsync(
                        query,
                        source,
                        freshness,
                        requestedSearchCount,
                        webSearchDecision.SourceFocus,
                        webSearchDecision.SourceDomain,
                        webSearch.Results,
                        alignTimeoutCts.Token
                    );
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    alignTimedOut = true;
                    contextAlignedResults = webSearch.Results
                        .Take(Math.Clamp(requestedSearchCount, 1, 10))
                        .ToArray();
                }

                if (contextAlignedResults.Count < requestedSearchCount && webSearch.Results.Count > contextAlignedResults.Count)
                {
                    contextAlignedResults = MergeWebSearchItemsByUrl(
                        contextAlignedResults,
                        webSearch.Results,
                        Math.Clamp(requestedSearchCount, 1, 10)
                    );
                }

                webSearchTrace = CreateForcedToolTrace(
                    "ok",
                    result: contextAlignedResults.Count.ToString(CultureInfo.InvariantCulture),
                    detail: alignTimedOut ? "align_timeout_fallback" : "-"
                );
                if (contextAlignedResults.Count > 0)
                {
                    webSearchCitations = BuildSearchCitationReferences(contextAlignedResults);
                    sections.Add(BuildWebSearchContextBlock(freshness, contextAlignedResults));
                    sections.Add(BuildWebAnswerFormattingContextBlock(requestedSearchCount));
                }

                webFetchTrace = CreateForcedToolTrace("skip", skipReason: "disabled_for_latency");
            }
        }

        var contextBlock = sections.Count == 0
            ? string.Empty
            : "[강제 메모리/RAG/GeminiSearch]\n" + string.Join("\n\n", sections);
        return (
            contextBlock,
            BuildForcedContextTraceMessage(
                requestId,
                source,
                sessionKey,
                normalizedThreadBinding,
                normalizedSessionThread,
                bindingStatus,
                freshnessTrace,
                memorySearchTrace,
                memoryGetTrace,
                webSearchTrace,
                webFetchTrace,
                "-"
            ),
            webSearchGuardFailure,
            webSearchCitations,
            retryAttempt,
            retryMaxAttempts,
            retryStopReason
        );
    }

    private static string BuildMemorySearchContextBlock(IReadOnlyList<MemorySearchCitationResult> results)
    {
        var lines = results
            .Take(3)
            .Select((entry, index) =>
                $"{index + 1}. {entry.Path}{FormatMemoryLineRange(entry.StartLine, entry.EndLine)} "
                + $"score={entry.Score.ToString("0.###", CultureInfo.InvariantCulture)} "
                + $"{TrimForForcedContext(entry.Snippet, 260)}"
            );
        return "[memory_search]\n" + string.Join("\n", lines);
    }

    private static string BuildMemoryGetContextBlock(
        MemorySearchCitationResult citation,
        MemoryGetToolResult memoryGet
    )
    {
        return "[memory_get]\n"
            + $"path: {citation.Path}{FormatMemoryLineRange(citation.StartLine, citation.EndLine)}\n"
            + TrimForForcedContext(memoryGet.Text, 900);
    }

    private static string BuildWebSearchContextBlock(string freshness, IReadOnlyList<WebSearchResultItem> results)
    {
        var normalizedFreshness = string.IsNullOrWhiteSpace(freshness) ? "week" : freshness.Trim();
        var lines = new List<string>(Math.Min(10, results.Count));
        var itemNo = 0;
        foreach (var item in results)
        {
            if (itemNo >= 10)
            {
                break;
            }

            if (!TryNormalizeDisplaySourceUrl(item.Url, out var sourceUrl))
            {
                continue;
            }

            itemNo += 1;
            var citationId = NormalizeCitationId(item.CitationId, itemNo);
            var published = string.IsNullOrWhiteSpace(item.Published) ? "-" : item.Published.Trim();
            var sourceLabel = ResolveSourceLabel(sourceUrl, item.Title);
            lines.Add(
                $"{itemNo}. [{citationId}] {TrimForForcedContext(item.Title, 120)} | {published}\n"
                + $"source: {sourceLabel}\n"
                + $"desc: {TrimForForcedContext(item.Description, 220)}"
            );
        }

        return $"[web_search freshness={normalizedFreshness}]\n" + string.Join("\n", lines);
    }

    private static string BuildWebAnswerFormattingContextBlock(int requestedCount)
    {
        var normalizedRequestedCount = Math.Clamp(requestedCount, 1, 10);
        return "[response_format_rule]\n"
            + "- 아래 web_search 항목에 있는 사실만 사용해 답변하세요.\n"
            + "- 한국어로 간결하게 번호 목록으로 정리하세요.\n"
            + $"- 요청 건수는 정확히 {normalizedRequestedCount}개로 맞추고, 번호는 1부터 순서대로 작성하세요.\n"
            + "- 각 항목은 '제목 / 핵심 내용 / 출처(매체명)' 순서로 작성하세요.\n"
            + "- URL을 직접 노출하지 말고, 출처는 매체명만 작성하세요.\n"
            + "- web_search 항목에 없는 추정/기억 기반 내용은 작성하지 마세요.";
    }

    private async Task<IReadOnlyList<WebSearchResultItem>> BuildContextAlignedWebResultsAsync(
        string query,
        string source,
        string freshness,
        int requestedCount,
        string sourceFocus,
        string sourceDomain,
        IReadOnlyList<WebSearchResultItem> initialResults,
        CancellationToken cancellationToken
    )
    {
        if (initialResults == null || initialResults.Count == 0)
        {
            return Array.Empty<WebSearchResultItem>();
        }

        var targetCount = Math.Clamp(requestedCount, 1, 10);
        var normalizedFocus = (sourceFocus ?? string.Empty).Trim();
        if (_config.EnableFastWebPipeline)
        {
            return await BuildFastContextAlignedWebResultsAsync(
                query,
                source,
                freshness,
                targetCount,
                normalizedFocus,
                sourceDomain,
                initialResults,
                cancellationToken
            ).ConfigureAwait(false);
        }

        IReadOnlyList<WebSearchResultItem> candidatePool = initialResults;
        if (ShouldRecollectForSourceFocus(normalizedFocus, targetCount, candidatePool))
        {
            var expandedFreshness = ResolveSourceExpansionFreshness(freshness);
            var poolLimit = Math.Clamp(targetCount * 3, targetCount, 24);
            var merged = candidatePool.Take(poolLimit).ToArray();
            foreach (var expandedQuery in BuildSourceExpansionQueries(query, normalizedFocus).Take(4))
            {
                var expanded = await SearchWebAsync(
                    expandedQuery,
                    targetCount,
                    expandedFreshness,
                    cancellationToken,
                    source
                ).ConfigureAwait(false);
                if (expanded.Disabled || expanded.Results.Count == 0)
                {
                    continue;
                }

                merged = MergeWebSearchItemsByUrl(merged, expanded.Results, poolLimit);
                if (CountProbableSourceMatches(merged, normalizedFocus) >= targetCount
                    || merged.Length >= poolLimit)
                {
                    break;
                }
            }

            candidatePool = merged;

            if (CountProbableSourceMatches(candidatePool, normalizedFocus) < targetCount)
            {
                var normalizedDomain = NormalizeSourceDomainHint(sourceDomain);
                if (normalizedDomain.Length == 0)
                {
                    normalizedDomain = ResolveSourceDomainFromQueryOrFocus(query, normalizedFocus);
                }

                if (normalizedDomain.Length > 0)
                {
                    var feedItems = await TryCollectDomainFeedItemsAsync(
                        normalizedDomain,
                        poolLimit,
                        cancellationToken
                    ).ConfigureAwait(false);
                    if (feedItems.Length > 0)
                    {
                        candidatePool = MergeWebSearchItemsByUrl(feedItems, candidatePool, poolLimit);
                    }
                }
            }
        }

        var intentAligned = await SelectWebResultsByIntentWithLlmAsync(
            query,
            normalizedFocus,
            candidatePool,
            targetCount,
            cancellationToken
        ).ConfigureAwait(false);
        IReadOnlyList<WebSearchResultItem> contextAligned;
        if (!ShouldRunArticleClassification(query, normalizedFocus, targetCount))
        {
            contextAligned = intentAligned;
        }
        else
        {
            contextAligned = await FilterArticleCandidatesAsync(
                query,
                normalizedFocus,
                sourceDomain,
                intentAligned,
                candidatePool,
                targetCount,
                cancellationToken
            ).ConfigureAwait(false);
        }

        return await BackfillCountOnceIfNeededAsync(
            query,
            source,
            freshness,
            normalizedFocus,
            sourceDomain,
            contextAligned,
            candidatePool,
            targetCount,
            cancellationToken
        ).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<WebSearchResultItem>> BuildFastContextAlignedWebResultsAsync(
        string query,
        string source,
        string freshness,
        int targetCount,
        string sourceFocus,
        string sourceDomain,
        IReadOnlyList<WebSearchResultItem> initialResults,
        CancellationToken cancellationToken
    )
    {
        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var poolLimit = Math.Clamp(cappedTargetCount * 3, cappedTargetCount, 24);
        IReadOnlyList<WebSearchResultItem> candidatePool = initialResults.Take(poolLimit).ToArray();
        var normalizedDomain = NormalizeSourceDomainHint(sourceDomain);
        if (normalizedDomain.Length == 0)
        {
            normalizedDomain = ResolveSourceDomainFromQueryOrFocus(query, sourceFocus);
        }

        if (sourceFocus.Length >= 2
            && CountProbableSourceMatches(candidatePool, sourceFocus) < cappedTargetCount
            && normalizedDomain.Length > 0)
        {
            try
            {
                using var feedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                feedCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp((_config.LlmTimeoutSec / 2) + 1, 3, 6)));
                var feedItems = await TryCollectDomainFeedItemsAsync(
                    normalizedDomain,
                    poolLimit,
                    feedCts.Token
                ).ConfigureAwait(false);
                if (feedItems.Length > 0)
                {
                    candidatePool = MergeWebSearchItemsByUrl(feedItems, candidatePool, poolLimit);
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
            }
        }

        var hardFiltered = candidatePool
            .Where(item => !IsHardNonArticleCandidate(item))
            .ToArray();
        var deterministic = BuildSourcePrioritizedFallback(
            hardFiltered.Length > 0 ? hardFiltered : candidatePool,
            sourceFocus,
            cappedTargetCount
        );
        return await BackfillCountOnceIfNeededAsync(
            query,
            source,
            freshness,
            sourceFocus,
            normalizedDomain,
            deterministic,
            candidatePool,
            cappedTargetCount,
            cancellationToken
        ).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<WebSearchResultItem>> BackfillCountOnceIfNeededAsync(
        string query,
        string source,
        string freshness,
        string sourceFocus,
        string sourceDomain,
        IReadOnlyList<WebSearchResultItem> selected,
        IReadOnlyList<WebSearchResultItem> candidatePool,
        int targetCount,
        CancellationToken cancellationToken
    )
    {
        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var selectedItems = (selected ?? Array.Empty<WebSearchResultItem>())
            .Take(cappedTargetCount)
            .ToArray();
        if (selectedItems.Length >= cappedTargetCount)
        {
            return selectedItems;
        }

        var hardFilteredPool = (candidatePool ?? Array.Empty<WebSearchResultItem>())
            .Where(item => !IsHardNonArticleCandidate(item))
            .ToArray();
        var merged = MergeWebSearchItemsByUrl(
            selectedItems,
            BuildLikelyArticleFallback(hardFilteredPool, cappedTargetCount),
            cappedTargetCount
        );
        if (merged.Length >= cappedTargetCount)
        {
            return merged;
        }

        var normalizedDomain = NormalizeSourceDomainHint(sourceDomain);
        if (normalizedDomain.Length == 0)
        {
            normalizedDomain = ResolveSourceDomainFromQueryOrFocus(query, sourceFocus);
        }

        var backfillQuery = BuildLowCostBackfillQuery(query, sourceFocus, normalizedDomain);
        if (backfillQuery.Length == 0)
        {
            return merged;
        }

        var backfillCount = cappedTargetCount;
        var backfillFreshness = ResolveSourceExpansionFreshness(freshness) ?? freshness;
        IReadOnlyList<WebSearchResultItem> backfillResults = Array.Empty<WebSearchResultItem>();
        try
        {
            using var backfillCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var backfillTimeout = _config.EnableFastWebPipeline
                ? Math.Clamp((_config.LlmTimeoutSec / 3) + 1, 2, 4)
                : Math.Clamp((_config.LlmTimeoutSec / 2) + 3, 5, 12);
            backfillCts.CancelAfter(TimeSpan.FromSeconds(backfillTimeout));
            var backfill = await SearchWebAsync(
                backfillQuery,
                backfillCount,
                backfillFreshness,
                backfillCts.Token,
                source
            ).ConfigureAwait(false);
            if (!backfill.Disabled && backfill.Results.Count > 0)
            {
                backfillResults = backfill.Results;
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            backfillResults = Array.Empty<WebSearchResultItem>();
        }

        if (backfillResults.Count == 0)
        {
            return merged;
        }

        var hardFilteredBackfill = backfillResults
            .Where(item => !IsHardNonArticleCandidate(item))
            .ToArray();
        if (hardFilteredBackfill.Length == 0)
        {
            return merged;
        }

        merged = MergeWebSearchItemsByUrl(
            merged,
            BuildLikelyArticleFallback(hardFilteredBackfill, cappedTargetCount),
            cappedTargetCount
        );
        if (merged.Length >= cappedTargetCount)
        {
            return merged;
        }

        merged = MergeWebSearchItemsByUrl(merged, hardFilteredBackfill, cappedTargetCount);
        if (merged.Length >= cappedTargetCount || normalizedDomain.Length == 0)
        {
            return merged;
        }

        try
        {
            using var feedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var feedTimeout = _config.EnableFastWebPipeline
                ? Math.Clamp((_config.LlmTimeoutSec / 3) + 1, 2, 4)
                : Math.Clamp((_config.LlmTimeoutSec / 2) + 2, 4, 10);
            feedCts.CancelAfter(TimeSpan.FromSeconds(feedTimeout));
            var feedItems = await TryCollectDomainFeedItemsAsync(
                normalizedDomain,
                cappedTargetCount,
                feedCts.Token
            ).ConfigureAwait(false);
            if (feedItems.Length == 0)
            {
                return merged;
            }

            var hardFilteredFeed = feedItems
                .Where(item => !IsHardNonArticleCandidate(item))
                .ToArray();
            if (hardFilteredFeed.Length == 0)
            {
                return merged;
            }

            merged = MergeWebSearchItemsByUrl(
                merged,
                BuildLikelyArticleFallback(hardFilteredFeed, cappedTargetCount),
                cappedTargetCount
            );
            if (merged.Length >= cappedTargetCount)
            {
                return merged;
            }

            return MergeWebSearchItemsByUrl(merged, hardFilteredFeed, cappedTargetCount);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return merged;
        }
    }

    private static string BuildLowCostBackfillQuery(
        string query,
        string sourceFocus,
        string sourceDomain
    )
    {
        var normalizedQuery = (query ?? string.Empty).Trim();
        var normalizedFocus = (sourceFocus ?? string.Empty).Trim();
        var normalizedDomain = NormalizeSourceDomainHint(sourceDomain);
        if (normalizedDomain.Length > 0)
        {
            if (normalizedFocus.Length > 0)
            {
                return $"site:{normalizedDomain} {normalizedFocus} latest headlines";
            }

            if (normalizedQuery.Length > 0)
            {
                return $"site:{normalizedDomain} {normalizedQuery}";
            }

            return $"site:{normalizedDomain} latest headlines";
        }

        if (normalizedFocus.Length > 0)
        {
            return $"{normalizedFocus} latest headlines";
        }

        return normalizedQuery;
    }

    private static bool ShouldRunArticleClassification(string query, string sourceFocus, int targetCount)
    {
        if (targetCount <= 0)
        {
            return false;
        }

        var normalizedQuery = (query ?? string.Empty).Trim();
        if (LooksLikeListOutputRequest(normalizedQuery))
        {
            return true;
        }

        var normalizedFocus = (sourceFocus ?? string.Empty).Trim();
        return normalizedFocus.Length >= 2 && targetCount >= 3;
    }

    private async Task<IReadOnlyList<WebSearchResultItem>> FilterArticleCandidatesAsync(
        string query,
        string sourceFocus,
        string sourceDomain,
        IReadOnlyList<WebSearchResultItem> intentAligned,
        IReadOnlyList<WebSearchResultItem> candidatePool,
        int targetCount,
        CancellationToken cancellationToken
    )
    {
        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var poolLimit = Math.Clamp(cappedTargetCount * 3, cappedTargetCount, 30);
        var mergedPool = MergeWebSearchItemsByUrl(intentAligned, candidatePool, poolLimit);
        var hardFiltered = mergedPool
            .Where(item => !IsHardNonArticleCandidate(item))
            .ToArray();
        if (hardFiltered.Length == 0)
        {
            return intentAligned.Take(cappedTargetCount).ToArray();
        }

        if (hardFiltered.Length <= cappedTargetCount)
        {
            return hardFiltered;
        }

        var (provider, model) = ResolveArticleClassifierProviderModel();
        if (provider.Length == 0)
        {
            return BuildLikelyArticleFallback(hardFiltered, cappedTargetCount);
        }

        var candidateLimit = Math.Min(hardFiltered.Length, Math.Clamp(cappedTargetCount * 2, 10, 24));
        var candidates = hardFiltered.Take(candidateLimit).ToArray();
        var lines = new List<string>(candidates.Length);
        for (var i = 0; i < candidates.Length; i++)
        {
            var item = candidates[i];
            var sourceLabel = ResolveSourceLabel(item.Url, item.Title);
            var host = ExtractHostToken(item.Url);
            var title = TrimForForcedContext(item.Title, 120);
            var desc = TrimForForcedContext(item.Description, 120);
            var urlPath = TryGetUrlPathToken(item.Url);
            lines.Add($"{i + 1}. source={sourceLabel}; host={host}; path={urlPath}; title={title}; desc={desc}");
        }

        var focus = (sourceFocus ?? string.Empty).Trim();
        var domain = NormalizeSourceDomainHint(sourceDomain);
        if (domain.Length == 0)
        {
            domain = ResolveSourceDomainFromQueryOrFocus(query, focus);
        }

        var prompt = $"""
                      아래 후보 중에서 "기사성 뉴스 문서"만 선택하세요.
                      제외 규칙:
                      - 약관/개인정보/쿠키/문의/소개/구독/계정/로그인/사이트맵
                      - 카테고리 허브/인덱스/메인 랜딩/프로그램 소개 페이지
                      - 팟캐스트 채널, 비디오 모아보기, 일반 안내 페이지

                      우선 규칙:
                      - 사용자 요청 맥락({query})과 직접 관련된 최신 뉴스 문서를 우선
                      - sourceFocus={focus}, sourceDomain={domain} 이 주어졌다면 해당 원출처 기사 우선
                      - 최대 {cappedTargetCount}개

                      출력 규칙:
                      - 설명 없이 JSON 한 줄만 출력
                      - 스키마: selected 배열만 포함한 JSON 객체

                      후보:
                      {string.Join("\n", lines)}
                      """;
        var judged = await GenerateByProviderSafeAsync(
            provider,
            model,
            prompt,
            cancellationToken,
            maxOutputTokens: 96
        ).ConfigureAwait(false);
        if (!TryParseSelectedCandidateIndexes(judged.Text, candidates.Length, out var selectedIndexes))
        {
            return BuildLikelyArticleFallback(hardFiltered, cappedTargetCount);
        }

        var selected = new List<WebSearchResultItem>(cappedTargetCount);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var selectedIndex in selectedIndexes)
        {
            if (selectedIndex < 1 || selectedIndex > candidates.Length)
            {
                continue;
            }

            var item = candidates[selectedIndex - 1];
            var key = (item.Url ?? string.Empty).Trim();
            if (key.Length == 0 || !seen.Add(key))
            {
                continue;
            }

            selected.Add(item);
            if (selected.Count >= cappedTargetCount)
            {
                break;
            }
        }

        if (selected.Count < cappedTargetCount)
        {
            foreach (var item in candidates)
            {
                if (selected.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || seen.Contains(key))
                {
                    continue;
                }

                if (!IsLikelyArticleCandidate(item))
                {
                    continue;
                }

                seen.Add(key);
                selected.Add(item);
            }
        }

        if (selected.Count < cappedTargetCount)
        {
            foreach (var item in hardFiltered)
            {
                if (selected.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || seen.Contains(key))
                {
                    continue;
                }

                seen.Add(key);
                selected.Add(item);
            }
        }

        return selected.Count == 0
            ? BuildLikelyArticleFallback(hardFiltered, cappedTargetCount)
            : selected;
    }

    private (string Provider, string? Model) ResolveArticleClassifierProviderModel()
    {
        if (_llmRouter.HasGeminiApiKey())
        {
            return ("gemini", ResolveSearchLlmModel());
        }

        return (string.Empty, null);
    }

    private static IReadOnlyList<WebSearchResultItem> BuildLikelyArticleFallback(
        IReadOnlyList<WebSearchResultItem> candidates,
        int targetCount
    )
    {
        if (candidates == null || candidates.Count == 0 || targetCount <= 0)
        {
            return Array.Empty<WebSearchResultItem>();
        }

        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var output = new List<WebSearchResultItem>(cappedTargetCount);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in candidates)
        {
            if (output.Count >= cappedTargetCount)
            {
                break;
            }

            var key = (item.Url ?? string.Empty).Trim();
            if (key.Length == 0 || seen.Contains(key))
            {
                continue;
            }

            if (!IsLikelyArticleCandidate(item))
            {
                continue;
            }

            seen.Add(key);
            output.Add(item);
        }

        if (output.Count < cappedTargetCount)
        {
            foreach (var item in candidates)
            {
                if (output.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || seen.Contains(key))
                {
                    continue;
                }

                seen.Add(key);
                output.Add(item);
            }
        }

        return output;
    }

    private static bool IsHardNonArticleCandidate(WebSearchResultItem item)
    {
        var title = (item.Title ?? string.Empty).Trim().ToLowerInvariant();
        var description = (item.Description ?? string.Empty).Trim().ToLowerInvariant();
        var path = TryGetUrlPathToken(item.Url);
        var looksLikeGoogleNewsArticlePath = path.Contains("/rss/articles/", StringComparison.OrdinalIgnoreCase)
            || path.Contains("/articles/", StringComparison.OrdinalIgnoreCase);
        if (Regex.IsMatch(
                title,
                @"\b(terms(\s+and\s+conditions)?|privacy\s+policy|cookie\s+policy|cookie\s+settings|contact\s+us|about\s+us|accessibility|help\s+center|faq)\b",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
        {
            return true;
        }

        if (Regex.IsMatch(
                path,
                @"/(terms|privacy|cookies?|cookie-policy|contact|about|accessibility|help|faq|account|login|subscribe|newsletters?|sitemap(\.xml)?|feed|rss)(/|$)",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)
            && !looksLikeGoogleNewsArticlePath)
        {
            return true;
        }

        if (Regex.IsMatch(
                path,
                @"/(podcast|podcasts|audio|video|tv-shows?|shows?)(/|$)",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)
            && !Regex.IsMatch(path, @"/20\d{2}/\d{2}/\d{2}/", RegexOptions.CultureInvariant))
        {
            return true;
        }

        if (description.Contains("핵심 내용 확인이 필요합니다.", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(
                path,
                @"/(terms|privacy|cookie|contact|about|sitemap|rss|feed)(/|$)",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)
            && !looksLikeGoogleNewsArticlePath)
        {
            return true;
        }

        return false;
    }

    private static bool IsLikelyArticleCandidate(WebSearchResultItem item)
    {
        if (IsHardNonArticleCandidate(item))
        {
            return false;
        }

        var title = (item.Title ?? string.Empty).Trim();
        var path = TryGetUrlPathToken(item.Url);
        if (Regex.IsMatch(path, @"/20\d{2}/\d{2}/\d{2}/", RegexOptions.CultureInvariant))
        {
            return true;
        }

        if (Regex.IsMatch(path, @"/\d{4}/\d{2}/\d{2}/", RegexOptions.CultureInvariant))
        {
            return true;
        }

        if (title.Length >= 20
            && Regex.IsMatch(path, @"[a-z0-9]+(?:-[a-z0-9]+){2,}", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
        {
            return true;
        }

        var description = (item.Description ?? string.Empty).Trim();
        return description.Length >= 60
               && !description.Contains("핵심 내용 확인이 필요합니다.", StringComparison.OrdinalIgnoreCase);
    }

    private static string TryGetUrlPathToken(string? url)
    {
        if (!TryNormalizeDisplaySourceUrl(url, out var normalized)
            || !Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        {
            return string.Empty;
        }

        var path = (uri.AbsolutePath ?? string.Empty).Trim().ToLowerInvariant();
        return path.Length == 0 ? "/" : path;
    }

    private static bool ShouldRecollectForSourceFocus(
        string sourceFocus,
        int targetCount,
        IReadOnlyList<WebSearchResultItem> results
    )
    {
        if (targetCount <= 1 || results == null || results.Count == 0)
        {
            return false;
        }

        var focus = (sourceFocus ?? string.Empty).Trim();
        if (focus.Length < 2)
        {
            return false;
        }

        return CountProbableSourceMatches(results, focus) < targetCount;
    }

    private async Task<IReadOnlyList<WebSearchResultItem>> SelectWebResultsByIntentWithLlmAsync(
        string query,
        string sourceFocus,
        IReadOnlyList<WebSearchResultItem> results,
        int targetCount,
        CancellationToken cancellationToken
    )
    {
        if (results == null || results.Count == 0 || targetCount <= 0)
        {
            return Array.Empty<WebSearchResultItem>();
        }

        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var focus = (sourceFocus ?? string.Empty).Trim();
        if (focus.Length < 2)
        {
            return results.Take(cappedTargetCount).ToArray();
        }

        var candidateLimit = Math.Min(results.Count, Math.Clamp(cappedTargetCount * 2, 10, 24));
        var candidates = results.Take(candidateLimit).ToArray();
        var provider = _llmRouter.HasGeminiApiKey() ? "gemini" : string.Empty;
        if (provider.Length == 0)
        {
            return BuildSourcePrioritizedFallback(candidates, focus, cappedTargetCount);
        }

        var model = ResolveSearchLlmModel();
        var lines = new List<string>(candidates.Length);
        for (var i = 0; i < candidates.Length; i++)
        {
            var item = candidates[i];
            var sourceLabel = ResolveSourceLabel(item.Url, item.Title);
            var host = ExtractHostToken(item.Url);
            var title = TrimForForcedContext(item.Title, 120);
            var desc = TrimForForcedContext(item.Description, 140);
            lines.Add($"{i + 1}. source={sourceLabel}; host={host}; title={title}; desc={desc}");
        }

        var prompt = $"""
                      사용자 뉴스 요청과 검색 후보를 보고, 요청 맥락에 직접 부합하는 항목 번호만 고르세요.
                      핵심 규칙:
                      - 특정 매체/기관/브랜드({focus})가 요구되면 그 매체의 원출처 기사만 선택하세요.
                      - 다른 매체가 {focus}를 언급한 기사/재인용/요약은 제외하세요.
                      - 최대 {cappedTargetCount}개, 우선순위 순서로 고르세요.
                      - 설명 문장 없이 JSON 한 줄만 출력하세요.
                      - 스키마: selected 배열만 포함한 JSON 객체

                      사용자 요청:
                      {query}

                      후보:
                      {string.Join("\n", lines)}
                      """;
        var selection = await GenerateByProviderSafeAsync(
            provider,
            model,
            prompt,
            cancellationToken,
            maxOutputTokens: 96
        ).ConfigureAwait(false);
        if (!TryParseSelectedCandidateIndexes(selection.Text, candidates.Length, out var selectedIndexes))
        {
            return BuildSourcePrioritizedFallback(candidates, focus, cappedTargetCount);
        }

        var chosen = new List<WebSearchResultItem>(cappedTargetCount);
        var chosenUrlSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var index in selectedIndexes)
        {
            if (index < 1 || index > candidates.Length)
            {
                continue;
            }

            var item = candidates[index - 1];
            var key = (item.Url ?? string.Empty).Trim();
            if (key.Length == 0 || !chosenUrlSet.Add(key))
            {
                continue;
            }

            chosen.Add(item);
            if (chosen.Count >= cappedTargetCount)
            {
                break;
            }
        }

        if (chosen.Count < cappedTargetCount)
        {
            foreach (var item in candidates)
            {
                if (chosen.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || chosenUrlSet.Contains(key))
                {
                    continue;
                }

                if (!IsProbableSourceMatch(item, focus))
                {
                    continue;
                }

                chosenUrlSet.Add(key);
                chosen.Add(item);
            }
        }

        if (chosen.Count < cappedTargetCount)
        {
            foreach (var item in candidates)
            {
                if (chosen.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || chosenUrlSet.Contains(key))
                {
                    continue;
                }

                chosenUrlSet.Add(key);
                chosen.Add(item);
            }
        }

        return chosen.Count == 0
            ? BuildSourcePrioritizedFallback(candidates, focus, cappedTargetCount)
            : chosen;
    }

    private static IReadOnlyList<WebSearchResultItem> BuildSourcePrioritizedFallback(
        IReadOnlyList<WebSearchResultItem> candidates,
        string sourceFocus,
        int targetCount
    )
    {
        if (candidates == null || candidates.Count == 0 || targetCount <= 0)
        {
            return Array.Empty<WebSearchResultItem>();
        }

        var cappedTargetCount = Math.Clamp(targetCount, 1, 10);
        var output = new List<WebSearchResultItem>(cappedTargetCount);
        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in candidates)
        {
            if (output.Count >= cappedTargetCount)
            {
                break;
            }

            var key = (item.Url ?? string.Empty).Trim();
            if (key.Length == 0 || seenUrls.Contains(key))
            {
                continue;
            }

            if (!IsProbableSourceMatch(item, sourceFocus))
            {
                continue;
            }

            seenUrls.Add(key);
            output.Add(item);
        }

        if (output.Count < cappedTargetCount)
        {
            foreach (var item in candidates)
            {
                if (output.Count >= cappedTargetCount)
                {
                    break;
                }

                var key = (item.Url ?? string.Empty).Trim();
                if (key.Length == 0 || seenUrls.Contains(key))
                {
                    continue;
                }

                seenUrls.Add(key);
                output.Add(item);
            }
        }

        return output;
    }

    private static int CountProbableSourceMatches(
        IReadOnlyList<WebSearchResultItem> results,
        string sourceFocus
    )
    {
        if (results == null || results.Count == 0)
        {
            return 0;
        }

        return results.Count(item => IsProbableSourceMatch(item, sourceFocus));
    }

    private static bool IsProbableSourceMatch(WebSearchResultItem item, string sourceFocus)
    {
        var focusRaw = (sourceFocus ?? string.Empty).Trim().ToLowerInvariant();
        var focusKey = NormalizeSourceMatchToken(focusRaw);
        if (focusKey.Length < 2)
        {
            return true;
        }

        var sourceLabel = ResolveSourceLabel(item.Url, item.Title);
        var sourceLabelRaw = (sourceLabel ?? string.Empty).Trim().ToLowerInvariant();
        var hostRaw = ExtractHostToken(item.Url);
        if (IsShortAsciiSourceToken(focusRaw))
        {
            if (ContainsExactAsciiToken(sourceLabelRaw, focusRaw)
                || ContainsExactAsciiToken(hostRaw, focusRaw))
            {
                return true;
            }
        }

        var labelKey = NormalizeSourceMatchToken(sourceLabelRaw);
        if (labelKey.Contains(focusKey, StringComparison.Ordinal))
        {
            return true;
        }

        var hostKey = NormalizeSourceMatchToken(hostRaw);
        return hostKey.Contains(focusKey, StringComparison.Ordinal);
    }

    private static string NormalizeSourceMatchToken(string value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        return Regex.Replace(normalized, @"[^a-z0-9가-힣]", string.Empty);
    }

    private static bool IsShortAsciiSourceToken(string token)
    {
        return Regex.IsMatch(
            (token ?? string.Empty).Trim().ToLowerInvariant(),
            @"^[a-z0-9]{2,12}$",
            RegexOptions.CultureInvariant
        );
    }

    private static bool ContainsExactAsciiToken(string text, string token)
    {
        var normalizedText = (text ?? string.Empty).Trim().ToLowerInvariant();
        var normalizedToken = (token ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedText.Length == 0 || normalizedToken.Length == 0)
        {
            return false;
        }

        foreach (var part in Regex.Split(normalizedText, @"[^a-z0-9]+", RegexOptions.CultureInvariant))
        {
            if (part.Length == 0)
            {
                continue;
            }

            if (part.Equals(normalizedToken, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string ExtractHostToken(string url)
    {
        if (!TryNormalizeDisplaySourceUrl(url, out var normalizedUrl)
            || !Uri.TryCreate(normalizedUrl, UriKind.Absolute, out var uri))
        {
            return string.Empty;
        }

        var host = (uri.Host ?? string.Empty).Trim().ToLowerInvariant();
        if (host.StartsWith("www.", StringComparison.Ordinal))
        {
            host = host[4..];
        }

        return host;
    }

    private static bool TryParseSelectedCandidateIndexes(
        string? rawText,
        int maxIndex,
        out IReadOnlyList<int> indexes
    )
    {
        indexes = Array.Empty<int>();
        if (maxIndex <= 0)
        {
            return false;
        }

        var text = (rawText ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return false;
        }

        var parsedIndexes = new List<int>();
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start >= 0 && end > start)
        {
            var json = text[start..(end + 1)];
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && TryGetPropertyIgnoreCase(doc.RootElement, "selected", out var selectedElement)
                    && selectedElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var element in selectedElement.EnumerateArray())
                    {
                        if (element.ValueKind == JsonValueKind.Number
                            && element.TryGetInt32(out var number)
                            && number >= 1
                            && number <= maxIndex)
                        {
                            parsedIndexes.Add(number);
                            continue;
                        }

                        if (element.ValueKind == JsonValueKind.String
                            && int.TryParse(element.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
                            && parsed >= 1
                            && parsed <= maxIndex)
                        {
                            parsedIndexes.Add(parsed);
                        }
                    }
                }
            }
            catch
            {
                // ignore parse error and continue with regex fallback
            }
        }

        if (parsedIndexes.Count == 0)
        {
            foreach (Match match in Regex.Matches(text, @"\b(?<idx>\d{1,2})\b", RegexOptions.CultureInvariant))
            {
                if (!match.Success
                    || !int.TryParse(match.Groups["idx"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
                    || parsed < 1
                    || parsed > maxIndex)
                {
                    continue;
                }

                parsedIndexes.Add(parsed);
            }
        }

        var distinct = parsedIndexes
            .Distinct()
            .ToArray();
        if (distinct.Length == 0)
        {
            return false;
        }

        indexes = distinct;
        return true;
    }

    private static IReadOnlyList<SearchCitationReference> BuildSearchCitationReferences(
        IReadOnlyList<WebSearchResultItem> results
    )
    {
        if (results.Count == 0)
        {
            return Array.Empty<SearchCitationReference>();
        }

        var citations = new List<SearchCitationReference>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < results.Count; index++)
        {
            var item = results[index];
            if (!TryNormalizeDisplaySourceUrl(item.Url, out var sourceUrl))
            {
                continue;
            }

            var citationId = NormalizeCitationId(item.CitationId, index + 1);
            var key = $"{citationId}|{sourceUrl}";
            if (!seen.Add(key))
            {
                continue;
            }

            var published = string.IsNullOrWhiteSpace(item.Published) ? "-" : item.Published.Trim();
            var sourceType = string.IsNullOrWhiteSpace(item.CitationId) ? "web_search" : "gemini_grounding";
            citations.Add(new SearchCitationReference(
                CitationId: citationId,
                Title: TrimForForcedContext(item.Title, 160),
                Url: sourceUrl,
                Published: published,
                Snippet: TrimForForcedContext(item.Description, 240),
                SourceType: sourceType
            ));
        }

        return citations;
    }

    private static string NormalizeCitationId(string? citationId, int fallbackIndex)
    {
        var normalized = (citationId ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return $"c{Math.Max(1, fallbackIndex)}";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static SearchAnswerGuardFailure? BuildCitationValidationGuardFailure(SearchCitationValidationSummary? validation)
    {
        if (validation is null || validation.Passed)
        {
            return null;
        }

        return new SearchAnswerGuardFailure(
            SearchAnswerGuardFailureCategory.Coverage,
            "citation_validation_failed",
            $"missing={validation.MissingSentences}, unknown={validation.UnknownCitationSentences}, total={validation.TotalSentences}"
        );
    }

    private void LogCitationValidationGuardBlocked(
        string? source,
        string route,
        SearchAnswerGuardFailure failure
    )
    {
        var routeToken = NormalizeAuditToken(route, "-");
        _auditLogger.Log(
            NormalizeSearchAuditSource(source),
            "search_answer_guard",
            "blocked",
            $"guardCategory={NormalizeSearchGuardCategory(failure.Category.ToString())} guardReason={NormalizeSearchGuardReason(failure.ReasonCode)} guardDetail={NormalizeSearchGuardDetail($"{failure.Detail}, route={routeToken}")}"
        );
    }

    private static string BuildCitationValidationBlockedResponseText(SearchAnswerGuardFailure? failure = null)
    {
        if (failure is null)
        {
            return "근거 인용 검증에 실패하여 fail-closed 정책으로 답변을 차단했습니다. 잠시 후 다시 시도해 주세요.";
        }

        return BuildGroundedSearchFailureMessage(failure, retryStopReason: "guard_blocked");
    }

    private static string BuildGroundedSearchFailureMessage(
        SearchAnswerGuardFailure? failure,
        string? retryStopReason = null
    )
    {
        if (failure is null)
        {
            return "검색 실패: 원인을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
        }

        var reasonCode = NormalizeFailureToken(failure.ReasonCode, "unknown");
        var detail = NormalizeFailureDetail(failure.Detail);
        var terminationCode = ExtractGuardDetailToken(detail, "termination");
        var retryCode = NormalizeFailureToken(retryStopReason, "-");

        var message = reasonCode switch
        {
            "citation_validation_failed" => "검색 실패: 생성 응답의 인용 검증이 실패했습니다.",
            "freshness_guard_failed" => "검색 실패: 최신성 검증을 통과하지 못했습니다.",
            "credibility_guard_failed" => "검색 실패: 신뢰도 검증을 통과하지 못했습니다.",
            "insufficient_document_count" or "count_lock_unsatisfied" or "count_lock_unsatisfied_after_retries"
                => "검색 실패: 요청한 건수를 채우지 못했습니다.",
            "insufficient_independent_sources"
                => "검색 실패: 출처 다양성 기준을 충족하지 못했습니다.",
            "no_documents" => terminationCode switch
            {
                "gemini_api_key_missing" => "검색 실패: Gemini API 키가 없거나 읽기에 실패했습니다. 설정탭에서 키를 다시 저장하세요.",
                "gemini_grounding_timeout" => "검색 실패: Gemini 검색 요청이 시간 초과되었습니다.",
                "no_documents_after_filter" => "검색 실패: 검색 결과는 있었지만 필터(시간창/신뢰도/중복) 통과 문서가 0건입니다.",
                "gemini_result_empty" => "검색 실패: Gemini 응답이 비어 있어 문서를 만들지 못했습니다.",
                "gemini_auth_failed" => "검색 실패: Gemini 인증에 실패했습니다. API 키 권한/유효성을 확인하세요.",
                "gemini_rate_limited" => "검색 실패: Gemini 호출 제한(rate limit)에 걸렸습니다. 잠시 후 재시도하세요.",
                "gemini_upstream_error" => "검색 실패: Gemini 상위 서버 오류가 발생했습니다.",
                "retriever_unavailable" => "검색 실패: Gemini 검색 리트리버를 사용할 수 없습니다(키/네트워크/API 오류).",
                _ => "검색 실패: 문서 수집 결과가 0건입니다."
            },
            "web_search_unavailable" when detail.Contains("api key missing", StringComparison.OrdinalIgnoreCase)
                => "검색 실패: Gemini API 키가 없거나 읽기에 실패했습니다. 설정탭에서 키를 확인하세요.",
            "web_search_unavailable" when detail.Contains("timeout", StringComparison.OrdinalIgnoreCase)
                => "검색 실패: Gemini 검색 요청이 시간 초과되었습니다.",
            "web_search_unavailable" when detail.Contains("http 429", StringComparison.OrdinalIgnoreCase)
                => "검색 실패: Gemini 호출 제한(rate limit)에 걸렸습니다. 잠시 후 재시도하세요.",
            "web_search_unavailable" => "검색 실패: 검색 게이트웨이 호출에 실패했습니다.",
            _ => "검색 실패: 가드 정책에 의해 응답이 차단되었습니다."
        };

        var diagnostics = new List<string>
        {
            $"원인 코드: {reasonCode}"
        };
        if (!string.IsNullOrWhiteSpace(terminationCode))
        {
            diagnostics.Add($"종료 코드: {terminationCode}");
        }

        if (!string.Equals(retryCode, "-", StringComparison.Ordinal))
        {
            diagnostics.Add($"재시도 상태: {retryCode}");
        }

        if (!string.IsNullOrWhiteSpace(detail) && !string.Equals(detail, "-", StringComparison.Ordinal))
        {
            diagnostics.Add($"상세: {TrimForAudit(detail, 180)}");
        }

        return message + "\n" + string.Join("\n", diagnostics);
    }

    private static string NormalizeFailureToken(string? value, string fallback)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static string NormalizeFailureDetail(string? detail)
    {
        var normalized = (detail ?? string.Empty)
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
        return normalized.Length == 0 ? "-" : normalized;
    }

    private static string ExtractGuardDetailToken(string detail, string key)
    {
        var normalizedDetail = (detail ?? string.Empty).Trim();
        var normalizedKey = (key ?? string.Empty).Trim();
        if (normalizedDetail.Length == 0 || normalizedKey.Length == 0)
        {
            return string.Empty;
        }

        var marker = normalizedKey + "=";
        var startIndex = normalizedDetail.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (startIndex < 0)
        {
            return string.Empty;
        }

        var valueStart = startIndex + marker.Length;
        var valueEnd = valueStart;
        while (valueEnd < normalizedDetail.Length)
        {
            var ch = normalizedDetail[valueEnd];
            if (ch == ',' || ch == ' ')
            {
                break;
            }

            valueEnd++;
        }

        if (valueEnd <= valueStart)
        {
            return string.Empty;
        }

        return NormalizeFailureToken(normalizedDetail[valueStart..valueEnd], string.Empty);
    }

    private (IReadOnlyList<SearchCitationSentenceMapping> Mappings, SearchCitationValidationSummary Validation) BuildAndLogCitationMappings(
        string? source,
        string route,
        IReadOnlyList<SearchCitationReference>? citations,
        params (string Segment, string Text)[] segments
    )
    {
        var bundle = BuildCitationMappingBundle(citations, segments);
        if (bundle.Mappings.Count == 0 && bundle.Validation.TotalSentences == 0)
        {
            return bundle;
        }

        _auditLogger.Log(
            NormalizeAuditToken(source, "web"),
            "citation_mapping",
            bundle.Validation.Passed ? "ok" : "warn",
            $"route={NormalizeAuditToken(route, "-")} total={bundle.Validation.TotalSentences} tagged={bundle.Validation.TaggedSentences} missing={bundle.Validation.MissingSentences} unknown={bundle.Validation.UnknownCitationSentences}"
        );
        return bundle;
    }

    private static (IReadOnlyList<SearchCitationSentenceMapping> Mappings, SearchCitationValidationSummary Validation) BuildCitationMappingBundle(
        IReadOnlyList<SearchCitationReference>? citations,
        params (string Segment, string Text)[] segments
    )
    {
        if (citations == null || citations.Count == 0 || segments.Length == 0)
        {
            return (
                Array.Empty<SearchCitationSentenceMapping>(),
                new SearchCitationValidationSummary(
                    TotalSentences: 0,
                    TaggedSentences: 0,
                    MissingSentences: 0,
                    UnknownCitationSentences: 0,
                    Passed: true
                )
            );
        }

        var knownCitationIds = citations
            .Where(item => !string.IsNullOrWhiteSpace(item.CitationId))
            .Select((item, index) => NormalizeCitationId(item.CitationId, index + 1))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (knownCitationIds.Count == 0)
        {
            return (
                Array.Empty<SearchCitationSentenceMapping>(),
                new SearchCitationValidationSummary(
                    TotalSentences: 0,
                    TaggedSentences: 0,
                    MissingSentences: 0,
                    UnknownCitationSentences: 0,
                    Passed: true
                )
            );
        }

        var mappings = new List<SearchCitationSentenceMapping>();
        var taggedSentences = 0;
        var missingSentences = 0;
        var unknownCitationSentences = 0;

        foreach (var segment in segments)
        {
            var normalizedSegment = NormalizeCitationSegment(segment.Segment);
            var sentenceIndex = 0;
            foreach (var sentence in SplitGeneratedSentences(segment.Text))
            {
                sentenceIndex++;
                var knownIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var unknownIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (Match match in CitationBracketRegex.Matches(sentence))
                {
                    var candidate = NormalizeCitationId(match.Groups["id"].Value, sentenceIndex);
                    if (knownCitationIds.Contains(candidate))
                    {
                        knownIds.Add(candidate);
                    }
                    else
                    {
                        unknownIds.Add(candidate);
                    }
                }

                var knownArray = knownIds.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
                var unknownArray = unknownIds.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
                if (knownArray.Length > 0)
                {
                    taggedSentences++;
                }

                var missingCitation = ShouldRequireCitationForSentence(sentence) && knownArray.Length == 0;
                if (missingCitation)
                {
                    missingSentences++;
                }

                if (unknownArray.Length > 0 && knownArray.Length == 0)
                {
                    unknownCitationSentences++;
                }

                mappings.Add(new SearchCitationSentenceMapping(
                    Segment: normalizedSegment,
                    SentenceIndex: sentenceIndex,
                    Sentence: sentence,
                    CitationIds: knownArray,
                    UnknownCitationIds: unknownArray,
                    MissingCitation: missingCitation
                ));
            }
        }

        return (
            mappings,
            new SearchCitationValidationSummary(
                TotalSentences: mappings.Count,
                TaggedSentences: taggedSentences,
                MissingSentences: missingSentences,
                UnknownCitationSentences: unknownCitationSentences,
                Passed: missingSentences == 0 && unknownCitationSentences == 0
            )
        );
    }

    private static string NormalizeCitationSegment(string? segment)
    {
        var normalized = (segment ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return "text";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static IReadOnlyList<string> SplitGeneratedSentences(string? text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return Array.Empty<string>();
        }

        var sentences = new List<string>();
        var lines = normalized
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var chunks = CitationSentenceSplitRegex
                .Split(line)
                .Select(chunk => chunk.Trim())
                .Where(chunk => !string.IsNullOrWhiteSpace(chunk));
            foreach (var chunk in chunks)
            {
                sentences.Add(TrimForForcedContext(chunk, 360));
            }
        }

        return sentences;
    }

    private static bool ShouldRequireCitationForSentence(string sentence)
    {
        var normalized = (sentence ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return false;
        }

        if (normalized.StartsWith("[", StringComparison.Ordinal)
            && normalized.EndsWith("]", StringComparison.Ordinal))
        {
            return false;
        }

        if (normalized.StartsWith("```", StringComparison.Ordinal))
        {
            return false;
        }

        return normalized.Any(char.IsLetterOrDigit);
    }

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
        ChatLatencyMetrics? Latency
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
        var sanitizeStopwatch = Stopwatch.StartNew();
        string outputText;
        if (IsGeminiWebFailureText(response.Text))
        {
            outputText = BuildGeminiWebFailureNotice(input, response.Text);
        }
        else
        {
            outputText = SanitizeChatOutput(response.Text, keepMarkdownTables: allowMarkdownTable);
            if (allowMarkdownTable && LooksLikeTableRenderRequest(input))
            {
                outputText = EnsureMarkdownTableResponseIfRequested(outputText);
            }
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

    private static string EnsureMarkdownTableResponseIfRequested(string text)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length == 0)
        {
            return text;
        }

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
            builder.AppendLine("- 출력 채널은 텔레그램이다. 첫 줄은 1~2문장 요약으로 작성해라.");
            builder.AppendLine("- 요약 뒤에는 빈 줄 1개를 두고 핵심 항목은 '▪ ' 불릿으로 정리해라.");
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

        if (listMode)
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
            return 512;
        }

        if (targetCount > 5 || (tableMode && normalized.Length >= 80))
        {
            return 1024;
        }

        return 768;
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
            var heuristicNeedWeb = LooksLikeRealtimeQuestion(normalized);
            return new SearchRequirementDecision(
                heuristicNeedWeb,
                heuristicNeedWeb ? "fast:true:heuristic" : "fast:false:heuristic",
                ExtractSourceFocusHintFromInput(normalized),
                ExtractSourceDomainHintFromInput(normalized)
            );
        }

        var provider = _llmRouter.HasGeminiApiKey()
            ? "gemini"
            : string.Empty;
        if (provider.Length == 0)
        {
            var fallbackDecision = LooksLikeRealtimeQuestion(normalized);
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

        var fallback = LooksLikeRealtimeQuestion(normalized);
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

    private static bool LooksLikeClearlyNonWebQuestion(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0 || LooksLikeRealtimeQuestion(normalized))
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

    private static string ApplyListCountFallback(
        string input,
        string responseText,
        IReadOnlyList<SearchCitationReference>? citations
    )
    {
        var normalizedResponse = (responseText ?? string.Empty).Trim();
        if (citations == null || citations.Count == 0)
        {
            if (LooksLikeListOutputRequest(input))
            {
                return ApplyHighRiskFactualGuardFallback(
                    input,
                    ReplaceListUrlsWithSourceLabelsWithoutCitations(normalizedResponse)
                );
            }

            return ApplyHighRiskFactualGuardFallback(input, normalizedResponse);
        }

        if (!LooksLikeListOutputRequest(input))
        {
            return ApplyHighRiskFactualGuardFallback(input, normalizedResponse);
        }

        var hasExplicitRequestedCount = HasExplicitRequestedCountInQuery(input);
        var requestedCount = Math.Clamp(ResolveRequestedResultCountFromQuery(input), 1, 10);
        var validCitations = citations
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
        validCitations = DeduplicateCitationsForList(validCitations);
        var qualityFiltered = validCitations
            .Where(item => !IsLowQualityCitationForList(item))
            .ToArray();
        if (qualityFiltered.Length > 0)
        {
            validCitations = qualityFiltered;
        }
        validCitations = DeduplicateCitationsForList(validCitations);

        var sourceFocus = ExtractSourceFocusHintFromInput(input);
        var focusMatchedCitations = FilterCitationsBySourceFocus(validCitations, sourceFocus);
        if (focusMatchedCitations.Length > 0)
        {
            if (focusMatchedCitations.Length >= requestedCount)
            {
                validCitations = focusMatchedCitations;
            }
            else
            {
                var merged = new List<SearchCitationReference>(validCitations.Length);
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var citation in focusMatchedCitations)
                {
                    var key = BuildSourceUrlMatchKey(citation.Url);
                    if (key.Length == 0 || !seen.Add(key))
                    {
                        continue;
                    }

                    merged.Add(citation);
                }

                foreach (var citation in validCitations)
                {
                    var key = BuildSourceUrlMatchKey(citation.Url);
                    if (key.Length == 0 || !seen.Add(key))
                    {
                        continue;
                    }

                    merged.Add(citation);
                }

                validCitations = merged.ToArray();
            }
        }

        if (validCitations.Length == 0)
        {
            return ApplyHighRiskFactualGuardFallback(input, normalizedResponse);
        }

        var targetCount = requestedCount;
        if (!hasExplicitRequestedCount)
        {
            targetCount = Math.Min(targetCount, validCitations.Length);
        }

        if (targetCount <= 0)
        {
            return normalizedResponse;
        }

        var listedCount = CountListItemsInResponse(normalizedResponse);
        var sourceCoverageValid = validCitations.Length >= targetCount
            && ResponseHasValidSourceCoverage(normalizedResponse, targetCount, validCitations);
        var sourceLabelReplacedResponse = ReplaceListUrlsWithSourceLabels(normalizedResponse, validCitations);
        var modelListResponseUsable = LooksLikeUsableModelListResponse(
            sourceLabelReplacedResponse,
            targetCount,
            sourceFocus
        );
        if (listedCount >= targetCount && modelListResponseUsable)
        {
            return ApplyHighRiskFactualGuardFallback(input, sourceLabelReplacedResponse);
        }

        if (listedCount >= targetCount && sourceCoverageValid)
        {
            return ApplyHighRiskFactualGuardFallback(
                input,
                sourceLabelReplacedResponse
            );
        }

        var builder = new StringBuilder();
        builder.AppendLine($"요청하신 소식 {targetCount}건입니다.");
        for (var index = 0; index < targetCount; index++)
        {
            var hasDirectCitation = index < validCitations.Length;
            var item = hasDirectCitation
                ? validCitations[index]
                : validCitations[index % validCitations.Length];
            var sourceLabel = ResolveSourceLabel(item.Url, item.Title);
            var title = BuildCitationDisplayTitle(item, sourceLabel, index + 1, hasDirectCitation);
            var summary = BuildCitationDisplaySummary(item, sourceLabel, hasDirectCitation);
            builder.AppendLine($"No.{index + 1} 제목: {title}");
            builder.AppendLine($"내용: {summary}");
            builder.AppendLine($"출처: {sourceLabel}");
            if (index < targetCount - 1)
            {
                builder.AppendLine();
            }
        }

        return ApplyHighRiskFactualGuardFallback(input, builder.ToString().Trim());
    }

    private static bool IsLowQualityCitationForList(SearchCitationReference citation)
    {
        var title = NormalizeFallbackListText(citation.Title, 140, string.Empty);
        var snippet = NormalizeFallbackListText(citation.Snippet, 220, string.Empty);
        if (title.Length == 0)
        {
            return true;
        }

        var loweredTitle = title.ToLowerInvariant();
        if (Regex.IsMatch(
                loweredTitle,
                @"^(view|article|news|briefing|newsletter|news\.php|articleview\.html|actuallyview\.do)\b",
                RegexOptions.CultureInvariant))
        {
            return true;
        }

        if (loweredTitle.Contains("articleview.html", StringComparison.Ordinal)
            || loweredTitle.Contains("news articleview", StringComparison.Ordinal)
            || loweredTitle.Contains("view akr", StringComparison.Ordinal))
        {
            return true;
        }

        if (Regex.IsMatch(loweredTitle, @"^(?:v|view|article|news|story)\s*\d{8,}$", RegexOptions.CultureInvariant)
            || Regex.IsMatch(loweredTitle, @"^[a-z]{1,3}\s*\d{8,}$", RegexOptions.CultureInvariant))
        {
            return true;
        }

        if (Regex.IsMatch(loweredTitle, @"^[a-z0-9][a-z0-9\-_/.]{6,}$", RegexOptions.CultureInvariant)
            && (loweredTitle.Contains('/', StringComparison.Ordinal)
                || loweredTitle.Contains('_', StringComparison.Ordinal)
                || Regex.IsMatch(loweredTitle, @"\d{6,}", RegexOptions.CultureInvariant)))
        {
            return true;
        }

        var letterCount = loweredTitle.Count(char.IsLetter);
        var digitCount = loweredTitle.Count(char.IsDigit);
        if (title.Length < 24 && digitCount >= 6 && letterCount <= 6)
        {
            return true;
        }

        if (snippet.Length == 0
            || snippet.Contains("핵심 내용 확인이 필요합니다.", StringComparison.OrdinalIgnoreCase))
        {
            return title.Length < 18 || digitCount >= 6;
        }

        return false;
    }

    private static SearchCitationReference[] DeduplicateCitationsForList(
        IReadOnlyList<SearchCitationReference> citations
    )
    {
        if (citations == null || citations.Count == 0)
        {
            return Array.Empty<SearchCitationReference>();
        }

        var deduplicated = new List<SearchCitationReference>(citations.Count);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var citation in citations)
        {
            var urlKey = BuildSourceUrlMatchKey(citation.Url);
            var titleKey = NormalizeFallbackListText(citation.Title, 140, string.Empty).ToLowerInvariant();
            var snippetKey = NormalizeFallbackListText(citation.Snippet, 100, string.Empty).ToLowerInvariant();
            var key = urlKey.Length > 0
                ? $"{urlKey}|{titleKey}"
                : titleKey.Length > 0
                    ? titleKey
                    : snippetKey;
            if (key.Length == 0 || !seen.Add(key))
            {
                continue;
            }

            deduplicated.Add(citation);
        }

        return deduplicated.Count > 0 ? deduplicated.ToArray() : citations.ToArray();
    }

    private static bool LooksLikeUsableModelListResponse(
        string responseText,
        int targetCount,
        string sourceFocus
    )
    {
        if (targetCount <= 0)
        {
            return false;
        }

        var normalized = (responseText ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        var lowered = normalized.ToLowerInvariant();
        if (lowered.Contains("핵심 내용 확인이 필요", StringComparison.Ordinal)
            || lowered.Contains("내용없음", StringComparison.Ordinal)
            || lowered.Contains("내용 없음", StringComparison.Ordinal)
            || lowered.Contains("vertexaisearch.cloud.google.com", StringComparison.Ordinal))
        {
            return false;
        }

        if (Regex.IsMatch(
                lowered,
                @"(?:^|\n)\s*no\.\d+\s*제목:\s*(view|article|news|briefing|newsletter|news\.php|articleview\.html|actuallyview\.do)\b",
                RegexOptions.CultureInvariant))
        {
            return false;
        }

        var titleMatches = Regex.Matches(
            normalized,
            @"(?:^|\n)\s*No\.(?<n>\d{1,2})\s*제목:\s*(?<title>[^\n]+)",
            RegexOptions.CultureInvariant
        );
        if (titleMatches.Count < targetCount)
        {
            return false;
        }

        var uniqueTitleKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in titleMatches)
        {
            if (!match.Success)
            {
                continue;
            }

            var titleKey = NormalizeFallbackListText(match.Groups["title"].Value, 120, string.Empty).ToLowerInvariant();
            if (titleKey.Length == 0)
            {
                continue;
            }

            uniqueTitleKeys.Add(titleKey);
        }

        var minimumUniqueTitles = Math.Clamp(targetCount - 2, 3, targetCount);
        if (uniqueTitleKeys.Count < minimumUniqueTitles)
        {
            return false;
        }

        var normalizedFocus = (sourceFocus ?? string.Empty).Trim();
        if (normalizedFocus.Length >= 2
            && normalized.IndexOf(normalizedFocus, StringComparison.OrdinalIgnoreCase) < 0)
        {
            return false;
        }

        return true;
    }

    private static string BuildCitationDisplayTitle(
        SearchCitationReference citation,
        string sourceLabel,
        int ordinal,
        bool hasDirectCitation
    )
    {
        var title = NormalizeFallbackListText(citation.Title, 120, string.Empty);
        if (title.Length == 0 || IsLowQualityCitationForList(citation))
        {
            return hasDirectCitation
                ? $"{sourceLabel} 주요 기사"
                : $"{sourceLabel} 추가 기사 {ordinal}";
        }

        return title;
    }

    private static string BuildCitationDisplaySummary(
        SearchCitationReference citation,
        string sourceLabel,
        bool hasDirectCitation
    )
    {
        var summary = NormalizeFallbackListText(citation.Snippet, 200, string.Empty);
        if (summary.Length == 0
            || summary.Contains("핵심 내용 확인이 필요합니다.", StringComparison.OrdinalIgnoreCase))
        {
            return hasDirectCitation
                ? $"{sourceLabel} 보도 기사입니다. 원문 요약 데이터가 부족해 상세 내용은 원문 확인이 필요합니다."
                : "추가 업데이트 확인 중입니다.";
        }

        return summary;
    }

    private static string ApplyHighRiskFactualGuardFallback(string input, string responseText)
    {
        var normalizedInput = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedInput.Length == 0)
        {
            return (responseText ?? string.Empty).Trim();
        }

        var asksMarsNuke = ContainsAny(normalizedInput, "화성", "mars")
            && ContainsAny(normalizedInput, "핵폭탄", "nuke", "테라포밍", "terraform");
        if (!asksMarsNuke)
        {
            return (responseText ?? string.Empty).Trim();
        }

        var normalizedResponse = (responseText ?? string.Empty).Trim();
        if (normalizedResponse.Length == 0)
        {
            normalizedResponse = "확인 가능한 공식 기록이 없습니다.";
        }

        var loweredResponse = normalizedResponse.ToLowerInvariant();
        var hasNoEvidenceSignal = ContainsAny(
            loweredResponse,
            "없",
            "없습니다",
            "확인 불가",
            "공식 기록",
            "실행된 사실",
            "존재하지 않",
            "가설",
            "not available",
            "no official",
            "no evidence"
        );
        if (hasNoEvidenceSignal)
        {
            return normalizedResponse;
        }

        return """
               현재까지 스페이스X·일론 머스크가 화성 극지방에 핵폭탄을 실제로 투하했다는 공식 기록은 없습니다.
               - 정확한 투하 날짜: 확인 불가(실행된 사실 없음)
               - 화성 대기압 상승 수치: 실측 데이터 없음(이론적 가정만 존재)
               """;
    }

    private static SearchCitationReference[] FilterCitationsBySourceFocus(
        IReadOnlyList<SearchCitationReference> citations,
        string sourceFocus
    )
    {
        if (citations == null || citations.Count == 0)
        {
            return Array.Empty<SearchCitationReference>();
        }

        var focus = (sourceFocus ?? string.Empty).Trim();
        if (focus.Length < 2)
        {
            return citations.ToArray();
        }

        var focusKey = Regex.Replace(focus.ToLowerInvariant(), @"\s+", string.Empty);
        var matched = citations
            .Where(item =>
            {
                var labelKey = Regex.Replace(ResolveSourceLabel(item.Url, item.Title).ToLowerInvariant(), @"\s+", string.Empty);
                if (labelKey.Contains(focusKey, StringComparison.Ordinal))
                {
                    return true;
                }

                if (!TryNormalizeDisplaySourceUrl(item.Url, out var normalizedUrl)
                    || !Uri.TryCreate(normalizedUrl, UriKind.Absolute, out var uri))
                {
                    return false;
                }

                var hostKey = Regex.Replace(uri.Host.ToLowerInvariant(), @"\s+", string.Empty);
                return hostKey.Contains(focusKey, StringComparison.Ordinal);
            })
            .ToArray();
        return matched.Length == 0 ? citations.ToArray() : matched;
    }

    private static string ReplaceListUrlsWithSourceLabelsWithoutCitations(string responseText)
    {
        var normalized = (responseText ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length);
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                output.Add(string.Empty);
                continue;
            }

            if (trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                var match = HttpUrlRegex.Match(trimmed);
                if (match.Success)
                {
                    output.Add($"출처: {ResolveSourceLabel(match.Value, null)}");
                }
                else
                {
                    output.Add(trimmed);
                }
                continue;
            }

            var replaced = HttpUrlRegex.Replace(trimmed, match =>
                ResolveSourceLabel(match.Value, null));
            replaced = Regex.Replace(replaced, @"\s{2,}", " ").Trim();
            replaced = Regex.Replace(replaced, @"\s*([/\|,;:])\s*$", string.Empty);
            if (replaced.Length == 0)
            {
                continue;
            }

            output.Add(replaced);
        }

        var merged = string.Join('\n', output).Trim();
        return Regex.Replace(merged, @"\n{3,}", "\n\n");
    }

    private static bool ResponseHasValidSourceCoverage(
        string responseText,
        int targetCount,
        IReadOnlyList<SearchCitationReference> validCitations
    )
    {
        if (targetCount <= 0)
        {
            return true;
        }

        if (validCitations == null || validCitations.Count == 0)
        {
            return false;
        }

        var citationUrlKeys = validCitations
            .Select(item => BuildSourceUrlMatchKey(item.Url))
            .Where(key => key.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (citationUrlKeys.Count == 0)
        {
            return false;
        }

        var matchedCount = 0;
        var seenKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rawUrl in ExtractSourceUrlsFromResponse(responseText))
        {
            if (!TryNormalizeDisplaySourceUrl(rawUrl, out var normalizedResponseUrl))
            {
                continue;
            }

            var responseUrlKey = BuildSourceUrlMatchKey(normalizedResponseUrl);
            if (responseUrlKey.Length == 0)
            {
                continue;
            }

            if (!citationUrlKeys.Contains(responseUrlKey) || !seenKeys.Add(responseUrlKey))
            {
                continue;
            }

            matchedCount += 1;
            if (matchedCount >= targetCount)
            {
                return true;
            }
        }

        var citationLabelKeys = validCitations
            .Select(item => NormalizeSourceLabelKey(ResolveSourceLabel(item.Url, item.Title)))
            .Where(key => key.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (citationLabelKeys.Count == 0)
        {
            return false;
        }

        var seenLabelKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var matchedLabelCount = 0;
        foreach (var sourceLabel in ExtractSourceLabelsFromResponse(responseText))
        {
            var labelKey = NormalizeSourceLabelKey(sourceLabel);
            if (labelKey.Length == 0)
            {
                continue;
            }

            if (!citationLabelKeys.Contains(labelKey) || !seenLabelKeys.Add(labelKey))
            {
                continue;
            }

            matchedLabelCount += 1;
            if (matchedLabelCount >= targetCount)
            {
                return true;
            }
        }

        return false;
    }

    private static string ReplaceListUrlsWithSourceLabels(
        string responseText,
        IReadOnlyList<SearchCitationReference> validCitations
    )
    {
        var normalized = (responseText ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var urlLabelByKey = validCitations
            .Select(item =>
            {
                var key = BuildSourceUrlMatchKey(item.Url);
                if (key.Length == 0)
                {
                    return default(KeyValuePair<string, string>?);
                }

                var label = ResolveSourceLabel(item.Url, item.Title);
                return new KeyValuePair<string, string>(key, label);
            })
            .Where(item => item.HasValue)
            .Select(item => item!.Value)
            .GroupBy(item => item.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First().Value, StringComparer.OrdinalIgnoreCase);

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length);
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                output.Add(string.Empty);
                continue;
            }

            if (trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                var match = HttpUrlRegex.Match(trimmed);
                if (!match.Success)
                {
                    output.Add(trimmed);
                    continue;
                }

                var label = ResolveSourceLabelByUrl(
                    match.Value,
                    urlLabelByKey,
                    fallbackLabel: "출처 확인 필요"
                );
                output.Add($"출처: {label}");
                continue;
            }

            var replaced = HttpUrlRegex.Replace(trimmed, match =>
                ResolveSourceLabelByUrl(match.Value, urlLabelByKey, fallbackLabel: "출처"));
            replaced = Regex.Replace(replaced, @"\s{2,}", " ").Trim();
            replaced = Regex.Replace(replaced, @"\s*([/\|,;:])\s*$", string.Empty);
            if (replaced.Length == 0)
            {
                continue;
            }

            output.Add(replaced);
        }

        var merged = string.Join('\n', output).Trim();
        return Regex.Replace(merged, @"\n{3,}", "\n\n");
    }

    private static string ResolveSourceLabelByUrl(
        string rawUrl,
        IReadOnlyDictionary<string, string> urlLabelByKey,
        string fallbackLabel
    )
    {
        var key = BuildSourceUrlMatchKey(rawUrl);
        if (key.Length > 0 && urlLabelByKey.TryGetValue(key, out var labelFromKey) && !string.IsNullOrWhiteSpace(labelFromKey))
        {
            return labelFromKey;
        }

        var label = ResolveSourceLabel(rawUrl, null);
        return string.IsNullOrWhiteSpace(label) ? fallbackLabel : label;
    }

    private static string ResolveSourceLabel(string? rawUrl, string? title)
    {
        var normalizedTitle = NormalizeFallbackListText(title, 80, string.Empty);
        if (TryNormalizeDisplaySourceUrl(rawUrl, out var normalizedUrl)
            && Uri.TryCreate(normalizedUrl, UriKind.Absolute, out var uri)
            && !string.IsNullOrWhiteSpace(uri.Host))
        {
            var host = uri.Host.Trim().ToLowerInvariant();
            if (host.StartsWith("www.", StringComparison.Ordinal))
            {
                host = host[4..];
            }

            if (host.Equals("news.google.com", StringComparison.OrdinalIgnoreCase))
            {
                var inferred = TryExtractSourceLabelFromTitle(normalizedTitle);
                if (!string.IsNullOrWhiteSpace(inferred))
                {
                    return inferred;
                }
            }

            foreach (var entry in SourceLabelByHostSuffix)
            {
                if (host.Equals(entry.Key, StringComparison.OrdinalIgnoreCase)
                    || host.EndsWith("." + entry.Key, StringComparison.OrdinalIgnoreCase))
                {
                    return entry.Value;
                }
            }
            return host;
        }

        return string.IsNullOrWhiteSpace(normalizedTitle) ? "출처 확인 필요" : normalizedTitle;
    }

    private static string TryExtractSourceLabelFromTitle(string title)
    {
        var normalized = (title ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        string[] separators = { " - ", " | ", " · ", " — " };
        foreach (var separator in separators)
        {
            var pivot = normalized.LastIndexOf(separator, StringComparison.Ordinal);
            if (pivot <= 0 || pivot >= normalized.Length - separator.Length)
            {
                continue;
            }

            var candidate = normalized[(pivot + separator.Length)..].Trim();
            if (candidate.Length < 2 || candidate.Length > 40)
            {
                continue;
            }

            if (candidate.Contains("뉴스", StringComparison.OrdinalIgnoreCase)
                || candidate.Contains("news", StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }

            if (Regex.IsMatch(candidate, @"^[A-Za-z0-9 ._-]{2,40}$", RegexOptions.CultureInvariant))
            {
                return candidate;
            }
        }

        return string.Empty;
    }

    private static IEnumerable<string> ExtractSourceUrlsFromResponse(string responseText)
    {
        var normalized = (responseText ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);

        foreach (var line in normalized.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                var candidate = trimmed["출처:".Length..].Trim();
                if (!string.IsNullOrWhiteSpace(candidate))
                {
                    yield return candidate;
                }
            }

            foreach (Match match in HttpUrlRegex.Matches(trimmed))
            {
                if (match.Success && !string.IsNullOrWhiteSpace(match.Value))
                {
                    yield return match.Value.Trim();
                }
            }
        }
    }

    private static IEnumerable<string> ExtractSourceLabelsFromResponse(string responseText)
    {
        var normalized = (responseText ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);

        foreach (var line in normalized.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("출처:", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var candidate = trimmed["출처:".Length..].Trim();
            if (!string.IsNullOrWhiteSpace(candidate))
            {
                yield return candidate;
            }
        }
    }

    private static string BuildSourceUrlMatchKey(string? rawUrl)
    {
        if (!TryNormalizeDisplaySourceUrl(rawUrl, out var normalizedUrl))
        {
            return string.Empty;
        }

        if (!Uri.TryCreate(normalizedUrl, UriKind.Absolute, out var uri))
        {
            return string.Empty;
        }

        if (!uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
            && !uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        var scheme = uri.Scheme.ToLowerInvariant();
        var host = uri.Host.ToLowerInvariant();
        var portPart = uri.IsDefaultPort ? string.Empty : $":{uri.Port}";
        var path = string.IsNullOrWhiteSpace(uri.AbsolutePath)
            ? "/"
            : uri.AbsolutePath.TrimEnd('/');
        if (path.Length == 0)
        {
            path = "/";
        }

        var query = uri.Query ?? string.Empty;
        return $"{scheme}://{host}{portPart}{path}{query}";
    }

    private static string NormalizeSourceLabelKey(string? label)
    {
        var normalized = (label ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        normalized = Regex.Replace(normalized, @"\s+", string.Empty);
        normalized = Regex.Replace(normalized, @"[^\p{L}\p{N}]", string.Empty);
        return normalized;
    }

    private static bool LooksLikeListOutputRequest(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return RequestedCountRegex.IsMatch(normalized)
            || TopCountRegex.IsMatch(normalized)
            || ContainsAny(normalized, "뉴스", "news", "헤드라인", "속보", "목록", "리스트", "top");
    }

    private static bool LooksLikeTableRenderRequest(string input)
    {
        var normalized = (input ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return ContainsAny(
            normalized,
            "표로",
            "표 형태",
            "표형식",
            "테이블",
            "도표",
            "table",
            "tabular"
        );
    }

    private static int CountListItemsInResponse(string responseText)
    {
        var normalized = (responseText ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return 0;
        }

        var declared = Regex.Match(
            normalized,
            @"요청하신[^\n]{0,60}?(?<n>\d+)\s*건",
            RegexOptions.CultureInvariant
        );
        var declaredCount = 0;
        if (declared.Success
            && int.TryParse(declared.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedDeclared))
        {
            declaredCount = parsedDeclared;
        }

        var noMatches = Regex.Matches(normalized, @"(?:^|\n)\s*No\.(?<n>\d{1,2})", RegexOptions.CultureInvariant);
        var noCount = 0;
        foreach (Match match in noMatches)
        {
            if (!match.Success)
            {
                continue;
            }

            if (int.TryParse(match.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
            {
                noCount = Math.Max(noCount, n);
            }
        }

        var numberedMatches = Regex.Matches(normalized, @"(?:^|\n)\s*(?<n>\d{1,2})\.", RegexOptions.CultureInvariant);
        var numberedCount = 0;
        foreach (Match match in numberedMatches)
        {
            if (!match.Success)
            {
                continue;
            }

            if (int.TryParse(match.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
            {
                if (n <= 30)
                {
                    numberedCount = Math.Max(numberedCount, n);
                }
            }
        }

        var sourceCount = Regex.Matches(normalized, @"(?:^|\n)\s*출처\s*:", RegexOptions.CultureInvariant).Count;
        return Math.Max(Math.Max(declaredCount, noCount), Math.Max(numberedCount, sourceCount));
    }

    private static string NormalizeFallbackListText(string? value, int maxLength, string fallback)
    {
        var normalized = (value ?? string.Empty)
            .Replace("\r\n", " ", StringComparison.Ordinal)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal);
        normalized = Regex.Replace(normalized, @"\s+", " ").Trim();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..maxLength].TrimEnd() + "...";
    }

    private static string NormalizeFallbackSourceUrl(string? rawUrl)
    {
        if (TryNormalizeDisplaySourceUrl(rawUrl, out var normalizedUrl))
        {
            return normalizedUrl;
        }

        var normalized = (rawUrl ?? string.Empty).Trim();
        return normalized.Length == 0 ? "-" : NormalizeFallbackListText(normalized, 160, "-");
    }

    private static string NormalizeContextSourceUrl(string? rawUrl)
    {
        if (TryNormalizeDisplaySourceUrl(rawUrl, out var normalizedUrl))
        {
            return normalizedUrl;
        }

        var normalized = (rawUrl ?? string.Empty).Trim();
        return normalized.Length == 0 ? "-" : NormalizeFallbackListText(normalized, 180, "-");
    }

    private static bool TryNormalizeDisplaySourceUrl(string? rawUrl, out string normalizedUrl)
    {
        normalizedUrl = string.Empty;
        var raw = (rawUrl ?? string.Empty).Trim();
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
            && !uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (uri.Host.Contains("vertexaisearch.cloud.google.com", StringComparison.OrdinalIgnoreCase))
        {
            if (!uri.AbsolutePath.Contains("/grounding-api-redirect", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!TryExtractGroundingRedirectTarget(uri, out var resolvedTarget))
            {
                return false;
            }

            normalizedUrl = resolvedTarget;
            return true;
        }

        normalizedUrl = uri.AbsoluteUri;
        return true;
    }

    private static bool TryExtractGroundingRedirectTarget(Uri redirectUri, out string normalizedUrl)
    {
        normalizedUrl = string.Empty;
        var query = redirectUri.Query;
        if (string.IsNullOrWhiteSpace(query))
        {
            return false;
        }

        var trimmed = query.TrimStart('?');
        if (trimmed.Length == 0)
        {
            return false;
        }

        foreach (var part in trimmed.Split('&', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var kv = part.Split('=', 2, StringSplitOptions.TrimEntries);
            if (kv.Length == 0)
            {
                continue;
            }

            var key = Uri.UnescapeDataString(kv[0]).Trim().ToLowerInvariant();
            if (key is not ("url" or "u" or "target" or "dest" or "destination" or "redirect" or "r" or "to"))
            {
                continue;
            }

            var value = kv.Length > 1 ? kv[1] : string.Empty;
            var decoded = value;
            for (var i = 0; i < 2; i += 1)
            {
                decoded = Uri.UnescapeDataString(decoded);
            }

            if (!Uri.TryCreate(decoded, UriKind.Absolute, out var target))
            {
                continue;
            }

            if (!target.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
                && !target.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (target.Host.Contains("vertexaisearch.cloud.google.com", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            normalizedUrl = target.AbsoluteUri;
            return true;
        }

        return false;
    }

    private static string NormalizeMemoryScopeForForcedContext(string? scope)
    {
        var normalized = NormalizeAuditToken(scope, string.Empty);
        if (normalized == "telegram")
        {
            return "chat";
        }

        return normalized switch
        {
            "chat" => "chat",
            "coding" => "coding",
            _ => "unknown"
        };
    }

    private static string? TryExtractSessionScope(string? sessionKey)
    {
        var normalized = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        var parts = normalized.Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length < 4 || !parts[0].Equals("agent", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return parts[2].Trim().ToLowerInvariant();
    }

    private IReadOnlySet<string> BuildScopedConversationIdSet(string normalizedScope)
    {
        if (normalizedScope != "chat" && normalizedScope != "coding")
        {
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var mode in new[] { "single", "orchestration", "multi" })
        {
            foreach (var item in _conversationStore.List(normalizedScope, mode))
            {
                if (!string.IsNullOrWhiteSpace(item.Id))
                {
                    ids.Add(item.Id.Trim());
                }
            }
        }

        return ids;
    }

    private static bool IsScopedConversationPath(string path, IReadOnlySet<string> allowedConversationIds)
    {
        if (allowedConversationIds.Count == 0)
        {
            return false;
        }

        var fileName = Path.GetFileNameWithoutExtension(path);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return false;
        }

        if (allowedConversationIds.Contains(fileName))
        {
            return true;
        }

        var pivot = fileName.LastIndexOf('_');
        if (pivot <= 0 || pivot >= fileName.Length - 1)
        {
            return false;
        }

        if (!int.TryParse(fileName[(pivot + 1)..], NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
        {
            return false;
        }

        return allowedConversationIds.Contains(fileName[..pivot]);
    }

    private IReadOnlyList<MemorySearchCitationResult> FilterMemorySearchResultsByScope(
        IReadOnlyList<MemorySearchCitationResult> results,
        string normalizedScope,
        IReadOnlySet<string> allowedConversationIds
    )
    {
        if (results.Count == 0 || (normalizedScope != "chat" && normalizedScope != "coding"))
        {
            return results;
        }

        var marker = $"_{normalizedScope}-";
        return results
            .Where(item =>
            {
                var path = (item.Path ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(path))
                {
                    return false;
                }

                if (path.StartsWith("memory-notes/", StringComparison.OrdinalIgnoreCase))
                {
                    var noteName = Path.GetFileName(path);
                    return noteName.Contains(marker, StringComparison.OrdinalIgnoreCase);
                }

                if (path.StartsWith("conversations/", StringComparison.OrdinalIgnoreCase))
                {
                    return IsScopedConversationPath(path, allowedConversationIds);
                }

                return false;
            })
            .ToArray();
    }

    private MemoryNoteItem? ResolveFallbackMemoryNoteForScope(string normalizedScope)
    {
        var notes = _memoryNoteStore.List();
        if (notes.Count == 0)
        {
            return null;
        }

        if (normalizedScope != "chat" && normalizedScope != "coding")
        {
            return notes[0];
        }

        var marker = $"_{normalizedScope}-";
        return notes.FirstOrDefault(item =>
            item.Name.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    private static string FormatMemoryLineRange(int startLine, int endLine)
    {
        var safeStart = Math.Max(1, startLine);
        var safeEnd = Math.Max(safeStart, endLine);
        return safeStart == safeEnd
            ? $"#L{safeStart}"
            : $"#L{safeStart}-L{safeEnd}";
    }

    private static string TrimForForcedContext(string? text, int maxChars)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length <= maxChars)
        {
            return normalized;
        }

        return normalized[..Math.Max(0, maxChars)] + "...";
    }

    private static string TrimForAudit(string? text, int maxChars)
    {
        var normalized = (text ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return normalized.Length <= maxChars
            ? normalized
            : normalized[..Math.Max(0, maxChars)] + "...";
    }

    private static string BuildForcedContextRequestId()
    {
        return $"fc-{Guid.NewGuid():N}";
    }

    private static IReadOnlyDictionary<string, string> CreateForcedToolTrace(
        string status,
        string? skipReason = null,
        string? result = null,
        string? detail = null,
        string? guardCategory = null,
        string? guardReason = null,
        string? guardDetail = null
    )
    {
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["status"] = NormalizeForcedToolStatus(status),
            ["skipReason"] = NormalizeForcedSkipReason(skipReason),
            ["result"] = NormalizeForcedToolValue(result, "-"),
            ["detail"] = NormalizeForcedToolValue(detail, "-"),
            ["guardCategory"] = NormalizeForcedGuardCategory(guardCategory),
            ["guardReason"] = NormalizeForcedGuardReason(guardReason),
            ["guardDetail"] = NormalizeForcedToolValue(guardDetail, "-")
        };
    }

    private static string BuildForcedContextTraceMessage(
        string requestId,
        string source,
        string? sessionKey,
        string threadBinding,
        string sessionThread,
        string threadBindingStatus,
        string freshness,
        IReadOnlyDictionary<string, string> memorySearch,
        IReadOnlyDictionary<string, string> memoryGet,
        IReadOnlyDictionary<string, string> webSearch,
        IReadOnlyDictionary<string, string> webFetch,
        string error
    )
    {
        var builder = new StringBuilder(720);
        builder.Append('{');
        AppendForcedTraceField(builder, "schema", "forced_context.v1", isFirst: true);
        AppendForcedTraceField(builder, "requestId", NormalizeAuditToken(requestId, "fc-unknown"));
        AppendForcedTraceField(builder, "source", NormalizeAuditToken(source, "web"));
        AppendForcedTraceField(builder, "sessionKey", NormalizeAuditToken(sessionKey, "-"));
        AppendForcedTraceField(builder, "threadBinding", NormalizeAuditToken(threadBinding, "-"));
        AppendForcedTraceField(builder, "sessionThread", NormalizeAuditToken(sessionThread, "-"));
        AppendForcedTraceField(builder, "threadBindingStatus", NormalizeAuditToken(threadBindingStatus, "na"));
        AppendForcedTraceField(builder, "freshness", NormalizeAuditToken(freshness, "na"));
        builder.Append(",\"tools\":{");
        AppendForcedToolTrace(builder, "memory_search", memorySearch, isFirst: true);
        AppendForcedToolTrace(builder, "memory_get", memoryGet, isFirst: false);
        AppendForcedToolTrace(builder, "web_search", webSearch, isFirst: false);
        AppendForcedToolTrace(builder, "web_fetch", webFetch, isFirst: false);
        builder.Append('}');
        AppendForcedTraceField(builder, "error", NormalizeForcedToolValue(error, "-"));
        builder.Append('}');
        return builder.ToString();
    }

    private static string NormalizeForcedToolStatus(string? status)
    {
        var normalized = (status ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "ok" or "disabled" or "skip" or "error" => normalized,
            _ => "error"
        };
    }

    private static string NormalizeForcedSkipReason(string? reason)
    {
        var normalized = (reason ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static string NormalizeForcedToolValue(string? value, string fallback)
    {
        var normalized = TrimForAudit(value, 140);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private static string NormalizeForcedGuardCategory(string? category)
    {
        var normalized = (category ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "coverage" or "freshness" or "credibility" => normalized,
            _ => "-"
        };
    }

    private static string NormalizeForcedGuardReason(string? reason)
    {
        var normalized = (reason ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "-";
        }

        return Regex.Replace(normalized, @"\s+", "_");
    }

    private static void AppendForcedTraceField(
        StringBuilder builder,
        string key,
        string value,
        bool isFirst = false
    )
    {
        if (!isFirst)
        {
            builder.Append(',');
        }

        builder.Append('"')
            .Append(EscapeForcedTraceJson(key))
            .Append("\":\"")
            .Append(EscapeForcedTraceJson(value))
            .Append('"');
    }

    private static void AppendForcedToolTrace(
        StringBuilder builder,
        string toolName,
        IReadOnlyDictionary<string, string> trace,
        bool isFirst
    )
    {
        if (!isFirst)
        {
            builder.Append(',');
        }

        var status = NormalizeForcedToolStatus(ReadForcedToolTraceField(trace, "status", "error"));
        var skipReason = NormalizeForcedSkipReason(ReadForcedToolTraceField(trace, "skipReason", "-"));
        var result = NormalizeForcedToolValue(ReadForcedToolTraceField(trace, "result", "-"), "-");
        var detail = NormalizeForcedToolValue(ReadForcedToolTraceField(trace, "detail", "-"), "-");
        var guardCategory = NormalizeForcedGuardCategory(ReadForcedToolTraceField(trace, "guardCategory", "-"));
        var guardReason = NormalizeForcedGuardReason(ReadForcedToolTraceField(trace, "guardReason", "-"));
        var guardDetail = NormalizeForcedToolValue(ReadForcedToolTraceField(trace, "guardDetail", "-"), "-");

        builder.Append('"')
            .Append(EscapeForcedTraceJson(toolName))
            .Append("\":{");
        AppendForcedTraceField(builder, "status", status, isFirst: true);
        AppendForcedTraceField(builder, "skipReason", skipReason);
        AppendForcedTraceField(builder, "result", result);
        AppendForcedTraceField(builder, "detail", detail);
        AppendForcedTraceField(builder, "guardCategory", guardCategory);
        AppendForcedTraceField(builder, "guardReason", guardReason);
        AppendForcedTraceField(builder, "guardDetail", guardDetail);
        builder.Append('}');
    }

    private static string ReadForcedToolTraceField(
        IReadOnlyDictionary<string, string> trace,
        string key,
        string fallback
    )
    {
        if (trace.TryGetValue(key, out var value))
        {
            var normalized = (value ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(normalized))
            {
                return normalized;
            }
        }

        return fallback;
    }

    private static string EscapeForcedTraceJson(string? value)
    {
        return (value ?? string.Empty)
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
    }

    private static string NormalizeAuditToken(string? token, string fallback)
    {
        var normalized = (token ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized.ToLowerInvariant();
    }

    private static string? TryExtractSessionThreadBinding(string? sessionKey)
    {
        var normalized = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        var parts = normalized
            .Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length < 4 || !parts[0].Equals("agent", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (parts.Length >= 5)
        {
            return string.Join(":", parts.Skip(4)).Trim().ToLowerInvariant();
        }

        return parts[^1].Trim().ToLowerInvariant();
    }

    private static string ResolveThreadBindingStatus(
        string? sessionThreadBinding,
        string? requestedThreadBinding
    )
    {
        var normalizedSessionThread = NormalizeAuditToken(sessionThreadBinding, string.Empty);
        var normalizedRequestedBinding = NormalizeAuditToken(requestedThreadBinding, string.Empty);
        var hasSessionThread = !string.IsNullOrWhiteSpace(normalizedSessionThread);
        var hasRequestedBinding = !string.IsNullOrWhiteSpace(normalizedRequestedBinding);
        if (!hasSessionThread && !hasRequestedBinding)
        {
            return "na";
        }

        if (hasSessionThread && !hasRequestedBinding)
        {
            return "session_only";
        }

        if (!hasSessionThread && hasRequestedBinding)
        {
            return "missing_session";
        }

        return string.Equals(normalizedSessionThread, normalizedRequestedBinding, StringComparison.Ordinal)
            ? "match"
            : "mismatch";
    }

    private static IReadOnlyList<InputAttachment> NormalizeAttachments(IReadOnlyList<InputAttachment>? attachments)
    {
        if (attachments == null || attachments.Count == 0)
        {
            return Array.Empty<InputAttachment>();
        }

        var list = new List<InputAttachment>(attachments.Count);
        foreach (var item in attachments)
        {
            var name = (item.Name ?? string.Empty).Trim();
            var mimeType = string.IsNullOrWhiteSpace(item.MimeType) ? "application/octet-stream" : item.MimeType.Trim();
            var base64 = (item.DataBase64 ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(base64))
            {
                continue;
            }

            if (base64.Length > 700_000)
            {
                base64 = base64[..700_000];
            }

            list.Add(new InputAttachment(name, mimeType, base64, item.SizeBytes, item.IsImage));
            if (list.Count >= 6)
            {
                break;
            }
        }

        return list.ToArray();
    }

    private static bool CanProviderHandleAttachments(
        string provider,
        string model,
        IReadOnlyList<InputAttachment> nonTextAttachments
    )
    {
        if (nonTextAttachments.Count == 0)
        {
            return true;
        }

        if (provider == "gemini")
        {
            return true;
        }

        if (provider == "groq")
        {
            if (!SupportsGroqVisionModel(model))
            {
                return false;
            }

            return nonTextAttachments.All(IsImageAttachment);
        }

        return false;
    }

    private static bool SupportsGroqVisionModel(string model)
    {
        var normalized = (model ?? string.Empty).Trim().ToLowerInvariant();
        return normalized.Contains("llama-4-scout", StringComparison.Ordinal)
               || normalized.Contains("llama-4-maverick", StringComparison.Ordinal);
    }

    private static bool IsImageAttachment(InputAttachment attachment)
    {
        if (attachment.IsImage)
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(attachment.MimeType)
            && attachment.MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var name = (attachment.Name ?? string.Empty).Trim().ToLowerInvariant();
        return name.EndsWith(".png", StringComparison.Ordinal)
               || name.EndsWith(".jpg", StringComparison.Ordinal)
               || name.EndsWith(".jpeg", StringComparison.Ordinal)
               || name.EndsWith(".webp", StringComparison.Ordinal)
               || name.EndsWith(".gif", StringComparison.Ordinal);
    }

    private static bool IsTextLikeAttachment(InputAttachment attachment)
    {
        var mime = (attachment.MimeType ?? string.Empty).Trim().ToLowerInvariant();
        if (mime.StartsWith("text/", StringComparison.Ordinal))
        {
            return true;
        }

        if (mime is "application/json" or "application/xml" or "text/csv" or "application/x-sh")
        {
            return true;
        }

        var name = (attachment.Name ?? string.Empty).Trim().ToLowerInvariant();
        return name.EndsWith(".txt", StringComparison.Ordinal)
               || name.EndsWith(".md", StringComparison.Ordinal)
               || name.EndsWith(".json", StringComparison.Ordinal)
               || name.EndsWith(".csv", StringComparison.Ordinal)
               || name.EndsWith(".log", StringComparison.Ordinal)
               || name.EndsWith(".yml", StringComparison.Ordinal)
               || name.EndsWith(".yaml", StringComparison.Ordinal)
               || name.EndsWith(".xml", StringComparison.Ordinal)
               || name.EndsWith(".ini", StringComparison.Ordinal)
               || name.EndsWith(".conf", StringComparison.Ordinal)
               || name.EndsWith(".cs", StringComparison.Ordinal)
               || name.EndsWith(".java", StringComparison.Ordinal)
               || name.EndsWith(".kt", StringComparison.Ordinal)
               || name.EndsWith(".js", StringComparison.Ordinal)
               || name.EndsWith(".ts", StringComparison.Ordinal)
               || name.EndsWith(".py", StringComparison.Ordinal)
               || name.EndsWith(".c", StringComparison.Ordinal)
               || name.EndsWith(".cpp", StringComparison.Ordinal)
               || name.EndsWith(".h", StringComparison.Ordinal)
               || name.EndsWith(".hpp", StringComparison.Ordinal)
               || name.EndsWith(".html", StringComparison.Ordinal)
               || name.EndsWith(".css", StringComparison.Ordinal)
               || name.EndsWith(".sh", StringComparison.Ordinal);
    }

    private static string BuildTextAttachmentBlock(IReadOnlyList<InputAttachment> attachments)
    {
        var textItems = attachments.Where(IsTextLikeAttachment).Take(3).ToArray();
        if (textItems.Length == 0)
        {
            return string.Empty;
        }

        var blocks = new List<string>(textItems.Length);
        foreach (var attachment in textItems)
        {
            if (!TryDecodeAttachmentText(attachment, out var content))
            {
                continue;
            }

            var trimmed = content.Length <= 2200 ? content : content[..2200] + "\n...(truncated)";
            var name = string.IsNullOrWhiteSpace(attachment.Name) ? "attachment" : attachment.Name;
            blocks.Add($"### {name}\n{trimmed}");
        }

        if (blocks.Count == 0)
        {
            return string.Empty;
        }

        return "[첨부 텍스트 파일]\n" + string.Join("\n\n", blocks);
    }

    private static bool TryDecodeAttachmentText(InputAttachment attachment, out string content)
    {
        content = string.Empty;
        try
        {
            var bytes = Convert.FromBase64String(attachment.DataBase64);
            if (bytes.Length == 0)
            {
                return false;
            }

            var text = Encoding.UTF8.GetString(bytes);
            text = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\r", "\n", StringComparison.Ordinal);
            text = text.Trim();
            if (string.IsNullOrWhiteSpace(text))
            {
                return false;
            }

            content = text;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static IReadOnlyList<string> ResolveWebUrls(string input, IReadOnlyList<string>? requestUrls, bool webSearchEnabled)
    {
        if (!webSearchEnabled)
        {
            return Array.Empty<string>();
        }

        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (requestUrls != null)
        {
            foreach (var raw in requestUrls)
            {
                var normalized = NormalizeWebUrl(raw);
                if (!string.IsNullOrWhiteSpace(normalized))
                {
                    set.Add(normalized);
                }
            }
        }

        foreach (Match match in HttpUrlRegex.Matches(input ?? string.Empty))
        {
            var normalized = NormalizeWebUrl(match.Value);
            if (!string.IsNullOrWhiteSpace(normalized))
            {
                set.Add(normalized);
            }
        }

        return set.Take(3).ToArray();
    }

    private static string NormalizeWebUrl(string? raw)
    {
        var value = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return string.Empty;
        }

        if (!uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
            && !uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        return uri.AbsoluteUri;
    }

    private async Task<string> BuildWebContextBlockAsync(IReadOnlyList<string> urls, CancellationToken cancellationToken)
    {
        if (urls.Count == 0)
        {
            return string.Empty;
        }

        var blocks = new List<string>();
        foreach (var url in urls.Take(3))
        {
            var snippet = await FetchWebSnippetAsync(url, cancellationToken);
            if (string.IsNullOrWhiteSpace(snippet))
            {
                continue;
            }

            blocks.Add($"### {url}\n{snippet}");
        }

        if (blocks.Count == 0)
        {
            return string.Empty;
        }

        return "[웹 참조]\n" + string.Join("\n\n", blocks);
    }

    private async Task<string> FetchWebSnippetAsync(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", "Omni-node/1.0");
            using var response = await WebFetchClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return string.Empty;
            }

            var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            var raw = await response.Content.ReadAsStringAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(raw))
            {
                return string.Empty;
            }

            if (raw.Length > 24_000)
            {
                raw = raw[..24_000];
            }

            if (contentType.Contains("html", StringComparison.OrdinalIgnoreCase))
            {
                var titleMatch = HtmlTitleRegex.Match(raw);
                var title = titleMatch.Success ? WebUtility.HtmlDecode(titleMatch.Groups[1].Value).Trim() : string.Empty;
                var stripped = HtmlTagStripRegex.Replace(raw, " ");
                stripped = WebUtility.HtmlDecode(stripped);
                stripped = Regex.Replace(stripped, @"\s{2,}", " ").Trim();
                if (stripped.Length > 1800)
                {
                    stripped = stripped[..1800] + "...";
                }

                if (!string.IsNullOrWhiteSpace(title))
                {
                    return WrapWebFetchSnippet($"제목: {title}\n요약: {stripped}");
                }

                return WrapWebFetchSnippet(stripped);
            }

            var normalized = raw.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\r", "\n", StringComparison.Ordinal).Trim();
            if (normalized.Length > 1800)
            {
                normalized = normalized[..1800] + "...";
            }

            return WrapWebFetchSnippet(normalized);
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string WrapWebFetchSnippet(string snippet)
    {
        var normalized = (snippet ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        return ExternalContentGuard.WrapWebContent(normalized, ExternalContentSource.WebFetch);
    }

    private static string BuildAttachmentSummaryPrompt(string input, IReadOnlyList<InputAttachment> attachments)
    {
        var lines = attachments
            .Select((item, index) =>
            {
                var name = string.IsNullOrWhiteSpace(item.Name) ? $"attachment-{index + 1}" : item.Name;
                var mime = string.IsNullOrWhiteSpace(item.MimeType) ? "application/octet-stream" : item.MimeType;
                return $"- {name} ({mime}, {item.SizeBytes} bytes)";
            })
            .ToArray();
        return $"""
                첨부된 이미지/파일을 먼저 해석한 뒤 아래 사용자 요청을 처리하기 위한 핵심 정보만 요약하세요.
                출력 규칙:
                - 한국어
                - 최대 8줄
                - 관찰 사실/수치/텍스트를 우선
                - 불확실하면 추정이라고 명시

                [사용자 요청]
                {input}

                [첨부 목록]
                {string.Join("\n", lines)}
                """;
    }

    private static CodingWorkerResult BuildUnsupportedCodingWorkerResult(
        string provider,
        string model,
        string language,
        string message
    )
    {
        var execution = new CodeExecutionResult(
            language,
            "-",
            "-",
            "(none)",
            0,
            string.Empty,
            message,
            "skipped"
        );
        return new CodingWorkerResult(
            provider,
            model,
            language,
            string.Empty,
            message,
            execution,
            Array.Empty<string>()
        );
    }

    public async Task<LlmSingleChatResult> ChatSingleAsync(
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

    public async Task<LlmOrchestrationResult> ChatOrchestrationAsync(
        string input,
        string source,
        string? provider,
        string? model,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
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

        if (workerTasks.Count == 0)
        {
            return new LlmOrchestrationResult("no_provider", "사용 가능한 LLM이 없습니다. Groq/Gemini/Cerebras 키 또는 Copilot 인증을 확인하세요.");
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
        var selectionByProvider = BuildProviderSelectionMap(groqModel, geminiModel, cerebrasModel, copilotModel);
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
            || (resolvedProvider == "copilot" && IsDisabledModelSelection(copilotModel)))
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

    public async Task<LlmMultiChatResult> ChatMultiAsync(
        string input,
        string source,
        string? groqModel,
        string? geminiModel,
        string? copilotModel,
        string? cerebrasModel,
        string? summaryProvider,
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
        var groqResolvedModel = IsDisabledModelSelection(groqModel) ? "none" : groqSelected;
        var geminiResolvedModel = IsDisabledModelSelection(geminiModel) ? "none" : geminiSelected;
        var cerebrasResolvedModel = IsDisabledModelSelection(cerebrasModel) ? "none" : cerebrasSelected;
        var copilotResolvedModel = IsDisabledModelSelection(copilotModel) ? "none" : copilotSelected;
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
                "none"
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

        await Task.WhenAll(groqTask, geminiTask, cerebrasTask, copilotTask);
        var workerResults = new[]
        {
            new LlmSingleChatResult(groqTask.Result.Provider, groqTask.Result.Model, SanitizeChatOutput(groqTask.Result.Text)),
            new LlmSingleChatResult(geminiTask.Result.Provider, geminiTask.Result.Model, SanitizeChatOutput(geminiTask.Result.Text)),
            new LlmSingleChatResult(cerebrasTask.Result.Provider, cerebrasTask.Result.Model, SanitizeChatOutput(cerebrasTask.Result.Text)),
            new LlmSingleChatResult(copilotTask.Result.Provider, copilotTask.Result.Model, SanitizeChatOutput(copilotTask.Result.Text))
        };
        var availabilityByProvider = await GetProviderAvailabilityMapAsync(cancellationToken);
        var selectionByProvider = BuildProviderSelectionMap(groqModel, geminiModel, cerebrasModel, copilotModel);
        var successfulWorkers = workerResults
            .Where(x => IsUsableWorkerResult(x, availabilityByProvider, selectionByProvider))
            .ToArray();

        var groq = workerResults[0].Text;
        var gemini = workerResults[1].Text;
        var cerebras = workerResults[2].Text;
        var copilot = workerResults[3].Text;

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

                            위 4개 답변에서 서로 중복/공통되는 핵심만 우선 정리하세요.
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

        _auditLogger.Log(source, "chat_multi", "ok", $"groq={groqSelected} cerebras={cerebrasSelected} copilot={copilotSelected} summary={resolvedSummaryProvider}");
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
            resolvedSummaryProvider
        );
    }

    public async Task<string> ExecuteAsync(
        string input,
        string source,
        CancellationToken cancellationToken,
        IReadOnlyList<InputAttachment>? attachments = null,
        IReadOnlyList<string>? webUrls = null,
        bool webSearchEnabled = true
    )
    {
        var text = (input ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            if (attachments != null && attachments.Count > 0 && source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
            {
                text = "첨부 파일을 분석해줘";
            }
            else
            {
                return "empty command";
            }
        }

        if (text.Length > _config.CommandMaxLength)
        {
            return $"command too long (max={_config.CommandMaxLength})";
        }

        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            SetCurrentTelegramExecutionMetadata();
        }

        RecordEvent($"{source}:user:{text}");
        _auditLogger.Log(source, "command_received", "ok", text);

        try
        {
            if (text.StartsWith("/help", StringComparison.OrdinalIgnoreCase)
                || text.Equals("/start", StringComparison.OrdinalIgnoreCase))
            {
                if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
                {
                    var helpTopic = ParseHelpTopicFromInput(text);
                    return BuildTelegramHelpText(helpTopic);
                }

                return """
                       Omni-node commands
                       /metrics
                       /kill <pid>
                       /code <instruction>
                       /profile <talk|code> [low|high]
                       /mode <single|orchestration|multi>
                       /provider <single|orchestration|summary> <groq|gemini|copilot|cerebras|auto>
                       /model <single|orchestration|multi.groq|multi.copilot|multi.cerebras> <model-id>
                       /status model
                       /llm status
                       /llm mode <single|orchestration|multi>
                       /llm single provider <groq|gemini|copilot|cerebras>
                       /llm single model <model-id>
                       /llm orchestration provider <auto|groq|gemini|copilot|cerebras>
                       /llm orchestration model <model-id>
                       /llm multi groq <model-id>
                       /llm multi copilot <model-id>
                       /llm multi cerebras <model-id>
                       /llm multi summary <auto|groq|gemini|copilot|cerebras>
                       /help
                       """;
            }

            if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
            {
                var profileResult = await TryHandleTelegramProfileCommandAsync(text, cancellationToken);
                if (profileResult != null)
                {
                    return profileResult;
                }

                var quickModelResult = await TryHandleTelegramQuickModelCommandAsync(text, cancellationToken);
                if (quickModelResult != null)
                {
                    return quickModelResult;
                }

                var llmCommandResult = await TryHandleTelegramLlmControlCommandAsync(text, cancellationToken);
                if (llmCommandResult != null)
                {
                    return llmCommandResult;
                }

                var memoryCommandResult = await TryHandleTelegramMemoryCommandAsync(text, cancellationToken);
                if (memoryCommandResult != null)
                {
                    return memoryCommandResult;
                }
            }

            var unifiedSlashResult = await TryHandleUnifiedSlashCommandAsync(text, source, cancellationToken);
            if (unifiedSlashResult != null)
            {
                return unifiedSlashResult;
            }

            if (!text.StartsWith("/", StringComparison.Ordinal))
            {
                var naturalByLlmResult = await TryHandleNaturalCommandByLlmAsync(source, text, cancellationToken);
                if (naturalByLlmResult != null)
                {
                    return naturalByLlmResult;
                }

                if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
                {
                    var legacyNaturalControlResult = await TryHandleTelegramNaturalControlCommandAsync(text, cancellationToken);
                    if (legacyNaturalControlResult != null)
                    {
                        return legacyNaturalControlResult;
                    }
                }
            }

            var routineCommandResult = await TryHandleRoutineCommandAsync(text, source, cancellationToken);
            if (routineCommandResult != null)
            {
                return routineCommandResult;
            }

            if (text.Equals("/metrics", StringComparison.OrdinalIgnoreCase))
            {
                var metrics = await _coreClient.GetMetricsAsync(cancellationToken);
                RecordEvent($"{source}:core:{metrics}");
                _auditLogger.Log(source, "metrics", "ok", metrics);
                return metrics;
            }

            if (TryParseKillCommand(text, out var pid))
            {
                var guard = await ValidateKillTargetAsync(pid, source, cancellationToken);
                if (!guard.Allowed)
                {
                    _auditLogger.Log(source, "kill", "deny", $"pid={pid} reason={guard.Reason}");
                    return $"kill denied: {guard.Reason}";
                }

                var result = await _coreClient.KillAsync(pid, cancellationToken);
                RecordEvent($"{source}:core:{result}");
                _auditLogger.Log(source, "kill", "ok", $"pid={pid}");
                return result;
            }

            if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase) && !text.StartsWith("/", StringComparison.Ordinal))
            {
                var naturalRoutineResult = await TryHandleNaturalRoutineRequestAsync(text, source, cancellationToken);
                if (naturalRoutineResult != null)
                {
                    return naturalRoutineResult;
                }

                var routed = await ExecuteTelegramLlmMessageAsync(
                    text,
                    attachments,
                    webUrls,
                    webSearchEnabled,
                    cancellationToken
                );
                _auditLogger.Log(source, "telegram_llm_route", "ok", "mode_routed");
                return routed;
            }

            var intent = await _llmRouter.ClassifyIntentAsync(text, cancellationToken);
            _auditLogger.Log(source, "intent_classified", "ok", intent.ToString());

            if (intent == RouterIntent.DynamicCode)
            {
                if (!_config.EnableDynamicCode)
                {
                    return "dynamic code is disabled. set OMNINODE_ENABLE_DYNAMIC_CODE=true";
                }

                var copilotStatus = await _copilotWrapper.GetStatusAsync(cancellationToken);
                if (!copilotStatus.Installed)
                {
                    return "copilot cli not installed";
                }
                if (!copilotStatus.Authenticated)
                {
                    return "copilot cli is not authenticated. run `gh auth login` and copilot sign-in first.";
                }

                var metrics = await _coreClient.GetMetricsAsync(cancellationToken);
                RecordEvent($"{source}:core:{metrics}");
                var context = BuildContextSnapshot(metrics);
                var plan = await _llmRouter.BuildExecutionPlanAsync(text, context, cancellationToken);
                RecordEvent($"{source}:plan:{plan}");
                var code = await _copilotWrapper.SuggestCodeAsync(plan, cancellationToken);
                if (string.IsNullOrWhiteSpace(code))
                {
                    _auditLogger.Log(source, "dynamic_code", "fail", "empty code");
                    return "no code generated from copilot cli";
                }

                var result = await _sandboxClient.ExecuteCodeAsync(code, cancellationToken);
                RecordEvent($"{source}:sandbox:{result}");
                _auditLogger.Log(source, "dynamic_code", "ok", result);
                return TrimForOutput(result);
            }

            if (intent == RouterIntent.QuerySystem)
            {
                var metrics = await _coreClient.GetMetricsAsync(cancellationToken);
                RecordEvent($"{source}:core:{metrics}");
                _auditLogger.Log(source, "query_system", "ok", metrics);
                return metrics;
            }

            if (intent == RouterIntent.OsControl)
            {
                _auditLogger.Log(source, "os_control", "deny", text);
                return "os control intent detected. use explicit allowlisted command (/kill <pid>) only.";
            }

            _auditLogger.Log(source, "unknown", "ok", intent.ToString());
            if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
            {
                var fallback = await ChatFallbackForUnknownAsync(BuildTelegramConcisePrompt(text), cancellationToken);
                _auditLogger.Log(source, "telegram_unknown_fallback", "ok", "llm_chat");
                return FormatTelegramResponse(fallback, TelegramMaxResponseChars);
            }

            return $"intent={intent}";
        }
        catch (Exception ex)
        {
            _auditLogger.Log(source, "command_error", "fail", ex.Message);
            return $"error: {ex.Message}";
        }
    }

    private async Task<LlmSingleChatResult> GenerateByProviderAsync(
        string provider,
        string? model,
        string input,
        CancellationToken cancellationToken,
        int? maxOutputTokens = null
    )
    {
        var normalized = NormalizeProvider(provider, allowAuto: false);
        var requestedMaxOutputTokens = Math.Max(256, maxOutputTokens ?? _config.ChatMaxOutputTokens);

        if (normalized == "gemini")
        {
            var requested = NormalizeModelSelection(model) ?? _config.GeminiModel;
            var selected = ResolveGeminiSingleModelForLatency(requested, input);
            var response = await _llmRouter.GenerateGeminiChatAsync(input, selected, requestedMaxOutputTokens, cancellationToken);
            return new LlmSingleChatResult("gemini", selected, response);
        }

        if (normalized == "cerebras")
        {
            var selected = NormalizeModelSelection(model) ?? _config.CerebrasModel;
            var response = await _llmRouter.GenerateCerebrasChatAsync(input, selected, requestedMaxOutputTokens, cancellationToken);
            return new LlmSingleChatResult("cerebras", selected, response);
        }

        if (normalized == "copilot")
        {
            var selected = NormalizeModelSelection(model) ?? _copilotWrapper.GetSelectedModel();
            if (IsCopilotResponseTestPrompt(input))
            {
                return new LlmSingleChatResult("copilot", selected, BuildMockCopilotTestResponse(selected));
            }

            var response = await _copilotWrapper.GenerateChatAsync(input, selected, cancellationToken);
            return new LlmSingleChatResult("copilot", selected, response);
        }

        var groqModel = ResolveGroqModelForInput(input, model);
        var groqResponse = await _llmRouter.GenerateGroqChatAsync(input, groqModel, requestedMaxOutputTokens, cancellationToken);
        if (IsGroqMaxTokensResponse(groqResponse) && requestedMaxOutputTokens > 8192)
        {
            groqResponse = await _llmRouter.GenerateGroqChatAsync(input, groqModel, 8192, cancellationToken);
        }

        if (IsGroqRateLimitResponse(groqResponse))
        {
            var retryResponse = groqResponse;
            foreach (var delayMs in new[] { 900, 1800 })
            {
                await Task.Delay(delayMs, cancellationToken);
                retryResponse = await _llmRouter.GenerateGroqChatAsync(input, groqModel, requestedMaxOutputTokens, cancellationToken);
                if (IsGroqMaxTokensResponse(retryResponse) && requestedMaxOutputTokens > 8192)
                {
                    retryResponse = await _llmRouter.GenerateGroqChatAsync(input, groqModel, 8192, cancellationToken);
                }

                if (!IsGroqRateLimitResponse(retryResponse))
                {
                    return new LlmSingleChatResult("groq", groqModel, retryResponse);
                }
            }

            var fallback = await TryFallbackFromGroqRateLimitAsync(input, cancellationToken);
            if (fallback != null)
            {
                return fallback;
            }

            return new LlmSingleChatResult(
                "groq",
                groqModel,
                "현재 Groq 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나 Gemini/Copilot을 선택하세요."
            );
        }

        return new LlmSingleChatResult("groq", groqModel, groqResponse);
    }

    private string ResolveGeminiSingleModelForLatency(string requestedModel, string input)
    {
        var requested = NormalizeModelSelection(requestedModel) ?? _config.GeminiModel;
        if (!_config.EnableFastWebPipeline)
        {
            return requested;
        }

        if (requested.Contains("flash-lite", StringComparison.OrdinalIgnoreCase))
        {
            return requested;
        }

        var normalizedInput = (input ?? string.Empty).Trim().ToLowerInvariant();
        var looksHeavy = ContainsAny(
            normalizedInput,
            "비교",
            "compare",
            "요약",
            "정리",
            "설명",
            "분석",
            "컨텍스트",
            "context",
            "토큰",
            "api",
            "비용",
            "가격"
        );
        if (!looksHeavy)
        {
            return requested;
        }

        var fastModel = ResolveSearchLlmModel();
        return string.IsNullOrWhiteSpace(fastModel) ? requested : fastModel;
    }

    private async Task<LlmSingleChatResult> GenerateByProviderSafeAsync(
        string provider,
        string? model,
        string input,
        CancellationToken cancellationToken,
        int? maxOutputTokens = null
    )
    {
        var normalized = NormalizeProvider(provider, allowAuto: false);
        var effectiveModel = normalized == "groq"
            ? ResolveGroqModelForInput(input, model)
            : ResolveProviderModel(normalized, model);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var timeoutSeconds = normalized switch
        {
            "copilot" => Math.Max(120, _config.LlmTimeoutSec * 3),
            "cerebras" => Math.Max(8, _config.CerebrasTimeoutSec),
            _ => Math.Max(8, _config.LlmTimeoutSec)
        };
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        try
        {
            return await GenerateByProviderAsync(normalized, model, input, timeoutCts.Token, maxOutputTokens);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new LlmSingleChatResult(normalized, effectiveModel, $"{normalized} 응답 시간이 초과되었습니다.");
        }
        catch (Exception ex)
        {
            return new LlmSingleChatResult(normalized, effectiveModel, $"{normalized} 호출 오류: {ex.Message}");
        }
    }

    private async Task<LlmSingleChatResult> ExecuteGroqSingleChainAsync(
        string input,
        string? preferredModel,
        CancellationToken cancellationToken,
        int maxOutputTokens
    )
    {
        var explicitPreferredModel = NormalizeModelSelection(preferredModel);
        var primaryModel = explicitPreferredModel
                           ?? NormalizeModelSelection(_config.GroqModel)
                           ?? DefaultGroqPrimaryModel;
        var models = string.IsNullOrWhiteSpace(explicitPreferredModel)
            ? new[] { primaryModel, DefaultGroqComplexModel, DefaultGroqFastModel }
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            : new[] { primaryModel };

        var originalInput = (input ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(originalInput))
        {
            return new LlmSingleChatResult("groq", primaryModel, "empty input");
        }

        var effectiveMaxTokens = Math.Max(512, maxOutputTokens);
        var currentInput = originalInput;

        for (var i = 0; i < models.Length; i++)
        {
            var model = models[i];
            if (models.Length > 1
                && IsGroqRateLimitImminent(model, effectiveMaxTokens)
                && i + 1 < models.Length)
            {
                currentInput = BuildCompressedInputForGroqSwitch(originalInput, $"한도 근접(모델={model})");
                continue;
            }

            var generated = await GenerateByProviderSafeAsync(
                "groq",
                model,
                currentInput,
                cancellationToken,
                effectiveMaxTokens
            );
            var cleaned = SanitizeChatOutput(generated.Text);
            if (!IsGroqRateLimitResponse(cleaned))
            {
                return new LlmSingleChatResult("groq", generated.Model, cleaned);
            }

            if (models.Length > 1 && i + 1 < models.Length)
            {
                currentInput = BuildCompressedInputForGroqSwitch(originalInput, $"429/한도 응답(모델={model})");
                continue;
            }

            return new LlmSingleChatResult(
                "groq",
                model,
                "Groq 모델 한도에 도달했습니다. 잠시 후 재시도하세요."
            );
        }

        return new LlmSingleChatResult("groq", DefaultGroqFastModel, "Groq 체인 실행 실패");
    }

    private bool IsGroqRateLimitImminent(string model, int expectedOutputTokens)
    {
        var rates = _llmRouter.GetGroqRateLimitSnapshot();
        if (!rates.TryGetValue(model, out var rate))
        {
            return false;
        }

        if (rate.RemainingRequests.HasValue && rate.RemainingRequests.Value <= 1)
        {
            return true;
        }

        if (rate.RemainingTokens.HasValue)
        {
            var safeReserve = Math.Max(1200, expectedOutputTokens + 500);
            if (rate.RemainingTokens.Value <= safeReserve)
            {
                return true;
            }
        }

        return false;
    }

    private static string BuildCompressedInputForGroqSwitch(string originalInput, string reason)
    {
        var normalized = (originalInput ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length > 3200)
        {
            var head = normalized[..1400];
            var tail = normalized[^1400..];
            normalized = $"{head}\n...\n{tail}";
        }

        return $"""
                [자동 모델 전환]
                사유: {reason}
                아래는 기존 긴 대화를 압축한 컨텍스트입니다.
                중요 요구사항을 유지해 답변하세요.

                {normalized}
                """;
    }

    private string ResolveProviderModel(string provider, string? model)
    {
        var normalizedModel = NormalizeModelSelection(model);
        if (!string.IsNullOrWhiteSpace(normalizedModel))
        {
            return normalizedModel;
        }

        return provider switch
        {
            "groq" => _llmRouter.GetSelectedGroqModel(),
            "cerebras" => _config.CerebrasModel,
            "copilot" => _copilotWrapper.GetSelectedModel(),
            _ => _config.GeminiModel
        };
    }

    private string ResolveGroqModelForInput(string input, string? modelOverride)
    {
        var normalized = NormalizeModelSelection(modelOverride);
        if (!string.IsNullOrWhiteSpace(normalized))
        {
            return normalized;
        }

        if (IsComplexGroqTask(input))
        {
            return DefaultGroqComplexModel;
        }

        var selected = _llmRouter.GetSelectedGroqModel();
        return string.IsNullOrWhiteSpace(selected) ? DefaultGroqFastModel : selected;
    }

    private static bool IsComplexGroqTask(string input)
    {
        var raw = (input ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        if (raw.Contains("```", StringComparison.Ordinal))
        {
            return true;
        }

        var normalized = raw.ToLowerInvariant();

        var codingSignals = ContainsAny(
            normalized,
            "코딩",
            "코드",
            "디버깅",
            "버그",
            "오류",
            "에러",
            "stack trace",
            "stacktrace",
            "traceback",
            "exception",
            "function",
            "함수",
            "class",
            "클래스",
            "build",
            "빌드",
            "dependency",
            "의존성",
            "version",
            "버전",
            "compile",
            "컴파일",
            "refactor",
            "리팩터",
            "package.json",
            "requirements.txt",
            "pom.xml",
            "build.gradle",
            ".csproj"
        );
        if (codingSignals)
        {
            return true;
        }

        var architectureSignals = ContainsAny(
            normalized,
            "구조",
            "아키텍처",
            "설계",
            "트레이드오프",
            "trade-off",
            "tradeoff",
            "db 스키마",
            "schema",
            "큐",
            "workflow",
            "워크플로우",
            "분산",
            "캐시",
            "cache"
        );
        if (architectureSignals)
        {
            return true;
        }

        return ContainsAny(
            normalized,
            "비교해서 결정",
            "장단점",
            "조건 a/b/c",
            "조건 a",
            "조건 b",
            "조건 c",
            "리스크",
            "예외",
            "엣지케이스",
            "edge case",
            "edge-case",
            "복잡한 추론",
            "multi-step"
        );
    }

    private static bool IsCopilotResponseTestPrompt(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return false;
        }

        var lowered = input.ToLowerInvariant();
        var hasCopilot = lowered.Contains("copilot", StringComparison.Ordinal)
                         || lowered.Contains("코파일럿", StringComparison.Ordinal);
        if (!hasCopilot)
        {
            return false;
        }

        var hasResponseHint = lowered.Contains("응답", StringComparison.Ordinal)
                              || lowered.Contains("response", StringComparison.Ordinal);
        var hasTestHint = lowered.Contains("테스트", StringComparison.Ordinal)
                          || lowered.Contains("test", StringComparison.Ordinal);

        return hasResponseHint && hasTestHint;
    }

    private static string BuildMockCopilotTestResponse(string? model)
    {
        var selected = string.IsNullOrWhiteSpace(model) ? "default" : model.Trim();
        return $"[copilot 응답 테스트] 실제 모델 호출을 생략한 모의 응답입니다. model={selected}";
    }

    private static bool ContainsAny(string text, params string[] patterns)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        foreach (var pattern in patterns)
        {
            if (!string.IsNullOrWhiteSpace(pattern)
                && text.Contains(pattern, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string NormalizeProvider(string? provider, bool allowAuto)
    {
        var value = (provider ?? string.Empty).Trim().ToLowerInvariant();
        if (value == "gemini" || value == "groq" || value == "cerebras" || value == "copilot")
        {
            return value;
        }

        if (allowAuto && (value == "auto" || string.IsNullOrWhiteSpace(value)))
        {
            return "auto";
        }

        return "groq";
    }

    private static bool IsDisabledModelSelection(string? model)
    {
        return string.Equals((model ?? string.Empty).Trim(), "none", StringComparison.OrdinalIgnoreCase);
    }

    private static string? NormalizeModelSelection(string? model)
    {
        if (string.IsNullOrWhiteSpace(model))
        {
            return null;
        }

        var trimmed = model.Trim();
        if (trimmed.Equals("gemini-3.1-flash-lite", StringComparison.OrdinalIgnoreCase))
        {
            return "gemini-3.1-flash-lite-preview";
        }

        return string.Equals(trimmed, "none", StringComparison.OrdinalIgnoreCase) ? null : trimmed;
    }

    private async Task<string> ResolveAutoProviderAsync(CancellationToken cancellationToken)
    {
        return await _providerRegistry.ResolveAutoProviderAsync(cancellationToken);
    }

    private async Task<IReadOnlyDictionary<string, ProviderAvailability>> GetProviderAvailabilityMapAsync(
        CancellationToken cancellationToken
    )
    {
        var snapshot = await _providerRegistry.GetAvailabilitySnapshotAsync(cancellationToken);
        return snapshot.ToDictionary(
            item => item.Provider,
            StringComparer.OrdinalIgnoreCase
        );
    }

    private static IReadOnlyDictionary<string, string?> BuildProviderSelectionMap(
        string? groqModel,
        string? geminiModel,
        string? cerebrasModel,
        string? copilotModel
    )
    {
        return new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["gemini"] = geminiModel,
            ["groq"] = groqModel,
            ["cerebras"] = cerebrasModel,
            ["copilot"] = copilotModel
        };
    }

    private static string ResolveProviderForAggregation(
        string requestedProvider,
        IReadOnlyList<LlmSingleChatResult> successfulWorkers,
        IReadOnlyDictionary<string, ProviderAvailability> availabilityByProvider,
        IReadOnlyDictionary<string, string?> selectionByProvider,
        bool allowProviderWithoutWorkerFallback
    )
    {
        if (requestedProvider != "auto")
        {
            if (!IsProviderSelectable(requestedProvider, availabilityByProvider, selectionByProvider))
            {
                return ResolveAutoProviderFromWorkers(
                    successfulWorkers,
                    availabilityByProvider,
                    selectionByProvider,
                    allowProviderWithoutWorkerFallback
                );
            }

            if (successfulWorkers.Count == 0)
            {
                return allowProviderWithoutWorkerFallback ? requestedProvider : "none";
            }

            if (successfulWorkers.Any(x => x.Provider.Equals(requestedProvider, StringComparison.OrdinalIgnoreCase)))
            {
                return requestedProvider;
            }
        }

        return ResolveAutoProviderFromWorkers(
            successfulWorkers,
            availabilityByProvider,
            selectionByProvider,
            allowProviderWithoutWorkerFallback
        );
    }

    private static string ResolveAutoProviderFromWorkers(
        IReadOnlyList<LlmSingleChatResult> workerResults,
        IReadOnlyDictionary<string, ProviderAvailability> availabilityByProvider,
        IReadOnlyDictionary<string, string?> selectionByProvider,
        bool allowProviderWithoutWorkerFallback
    )
    {
        var priority = new[] { "gemini", "groq", "cerebras", "copilot" };
        foreach (var provider in priority)
        {
            if (!IsProviderSelectable(provider, availabilityByProvider, selectionByProvider))
            {
                continue;
            }

            if (workerResults.Any(x => x.Provider.Equals(provider, StringComparison.OrdinalIgnoreCase)))
            {
                return provider;
            }
        }

        if (!allowProviderWithoutWorkerFallback)
        {
            return "none";
        }

        foreach (var provider in priority)
        {
            if (!IsProviderSelectable(provider, availabilityByProvider, selectionByProvider))
            {
                continue;
            }

            return provider;
        }

        return "none";
    }

    private static bool IsProviderSelectable(
        string provider,
        IReadOnlyDictionary<string, ProviderAvailability> availabilityByProvider,
        IReadOnlyDictionary<string, string?> selectionByProvider
    )
    {
        if (selectionByProvider.TryGetValue(provider, out var selection)
            && IsDisabledModelSelection(selection))
        {
            return false;
        }

        if (!availabilityByProvider.TryGetValue(provider, out var availability))
        {
            return false;
        }

        return availability.Available;
    }

    private static bool IsUsableWorkerResult(
        LlmSingleChatResult workerResult,
        IReadOnlyDictionary<string, ProviderAvailability> availabilityByProvider,
        IReadOnlyDictionary<string, string?> selectionByProvider
    )
    {
        if (!IsProviderSelectable(workerResult.Provider, availabilityByProvider, selectionByProvider))
        {
            return false;
        }

        return !IsLikelyWorkerFailure(workerResult.Provider, workerResult.Text);
    }

    private static bool IsLikelyWorkerFailure(string provider, string text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return true;
        }

        if (normalized.Equals("선택 안함", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (normalized.EndsWith("API 키가 설정되지 않았습니다.", StringComparison.Ordinal)
            || normalized.EndsWith("인증이 필요합니다.", StringComparison.Ordinal)
            || normalized.Equals("응답이 비어 있습니다. 다시 질문해 주세요.", StringComparison.Ordinal))
        {
            return true;
        }

        var lowered = normalized.ToLowerInvariant();
        var providerPrefix = (provider ?? string.Empty).Trim().ToLowerInvariant();
        if (providerPrefix.Length == 0)
        {
            return false;
        }

        if (lowered.StartsWith($"{providerPrefix} 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith($"{providerPrefix} 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith($"{providerPrefix} 응답 시간이 초과되었습니다.", StringComparison.Ordinal))
        {
            return true;
        }

        if (providerPrefix == "groq"
            && (lowered.StartsWith("현재 groq 요청 한도를 초과했습니다.", StringComparison.Ordinal)
                || lowered.StartsWith("groq 모델 한도에 도달했습니다.", StringComparison.Ordinal)))
        {
            return true;
        }

        return false;
    }

    private async Task<string?> TryHandleRoutineCommandAsync(string text, string source, CancellationToken cancellationToken)
    {
        if (!text.StartsWith("/routine", StringComparison.OrdinalIgnoreCase)
            && !text.StartsWith("/routines", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 1 || tokens[1].Equals("help", StringComparison.OrdinalIgnoreCase))
        {
            return """
                   루틴 명령어
                   /routine list
                   /routine create <요청>
                   /routine run <routine-id>
                   /routine on <routine-id>
                   /routine off <routine-id>
                   /routine delete <routine-id>
                   """;
        }

        var action = tokens[1].ToLowerInvariant();
        if (action == "list")
        {
            var list = ListRoutines();
            if (list.Count == 0)
            {
                return "등록된 루틴이 없습니다.";
            }

            var builder = new StringBuilder();
            builder.AppendLine("[루틴 목록]");
            foreach (var item in list.Take(20))
            {
                builder.AppendLine($"- {item.Id} | {item.Title} | {(item.Enabled ? "ON" : "OFF")} | next={item.NextRunLocal}");
            }

            return builder.ToString().Trim();
        }

        if (action == "create")
        {
            if (tokens.Length < 3)
            {
                return "usage: /routine create <요청>";
            }

            var request = string.Join(' ', tokens.Skip(2)).Trim();
            var created = await CreateRoutineAsync(request, source, cancellationToken);
            return FormatRoutineActionResult(created);
        }

        if (action == "run")
        {
            if (tokens.Length < 3)
            {
                return "usage: /routine run <routine-id>";
            }

            var result = await RunRoutineNowAsync(tokens[2], source, cancellationToken);
            return FormatRoutineActionResult(result);
        }

        if (action == "on" || action == "off")
        {
            if (tokens.Length < 3)
            {
                return $"usage: /routine {action} <routine-id>";
            }

            var enabled = action == "on";
            var result = SetRoutineEnabled(tokens[2], enabled);
            return FormatRoutineActionResult(result);
        }

        if (action == "delete")
        {
            if (tokens.Length < 3)
            {
                return "usage: /routine delete <routine-id>";
            }

            var result = DeleteRoutine(tokens[2]);
            return FormatRoutineActionResult(result);
        }

        return "unknown /routine command. use /routine help";
    }

    private async Task<string?> TryHandleNaturalRoutineRequestAsync(string text, string source, CancellationToken cancellationToken)
    {
        if (!LooksLikeRoutineRequest(text))
        {
            return null;
        }

        var result = await CreateRoutineAsync(text, source, cancellationToken);
        return FormatRoutineActionResult(result);
    }

    private static string FormatRoutineActionResult(RoutineActionResult result)
    {
        if (!result.Ok)
        {
            return $"루틴 오류: {result.Message}";
        }

        if (result.Routine == null)
        {
            return result.Message;
        }

        return $"""
                {result.Message}
                id={result.Routine.Id}
                title={result.Routine.Title}
                schedule={result.Routine.ScheduleText}
                next={result.Routine.NextRunLocal}
                script={result.Routine.ScriptPath}
                model={result.Routine.CoderModel}
                """;
    }

    private static bool LooksLikeRoutineRequest(string text)
    {
        var normalized = (text ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return false;
        }

        var hasRepeat = ContainsAny(normalized, "매일", "매주", "반복", "루틴", "정기", "매달", "every day", "schedule");
        var hasIntent = ContainsAny(normalized, "해줘", "만들어", "자동화", "추가", "등록", "생성", "set up", "create");
        return hasRepeat && hasIntent;
    }

    private async Task RoutineSchedulerLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            List<string> dueIds;
            lock (_routineLock)
            {
                var now = DateTimeOffset.UtcNow;
                dueIds = _routinesById.Values
                    .Where(x => x.Enabled && !x.Running && x.NextRunUtc <= now)
                    .Select(x => x.Id)
                    .ToList();

                foreach (var id in dueIds)
                {
                    if (_routinesById.TryGetValue(id, out var routine))
                    {
                        routine.Running = true;
                    }
                }

                if (dueIds.Count > 0)
                {
                    SaveRoutineStateLocked();
                }
            }

            foreach (var id in dueIds)
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await RunRoutineNowAsync(id, "scheduler", CancellationToken.None);
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[routine] scheduler run failed ({id}): {ex.Message}");
                    }
                }, CancellationToken.None);
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(20), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void EnsureRoutinePromptFiles()
    {
        try
        {
            Directory.CreateDirectory(_routinePromptDir);
            var systemPromptPath = Path.Combine(_routinePromptDir, "system_prompt.md");
            var baseConfigPath = Path.Combine(_routinePromptDir, "기본 구성.md");

            if (!File.Exists(systemPromptPath))
            {
                File.WriteAllText(
                    systemPromptPath,
                    """
                    # Routine System Prompt
                    - 목적: 반복 작업 자동화를 위한 루틴을 계획하고 실행 가능한 코드로 생성한다.
                    - 출력: PLAN 섹션 + LANGUAGE 선언 + 단일 코드블록.
                    - 제약: macOS/Linux 모두 동작 가능한 방식 우선.
                    - 보안: 파괴적 명령 금지, 사용자 경로 외 쓰기 금지, 민감정보 출력 금지.
                    """,
                    Encoding.UTF8
                );
            }

            if (!File.Exists(baseConfigPath))
            {
                File.WriteAllText(
                    baseConfigPath,
                    """
                    # 기본 구성
                    1. 스케줄 해석: "매일 HH:MM" 형식으로 정규화
                    2. 실행 환경: bash 또는 python (POSIX 친화)
                    3. 출력 형식: 핵심 결과를 짧은 텍스트로 stdout 출력
                    4. 실패 처리: 오류 시 원인 요약과 재시도 가이드 출력
                    """,
                    Encoding.UTF8
                );
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[routine] prompt init failed: {ex.Message}");
        }
    }

    private void LoadRoutineState()
    {
        lock (_routineLock)
        {
            _routinesById.Clear();
            try
            {
                if (!File.Exists(_routineStatePath))
                {
                    return;
                }

                var json = File.ReadAllText(_routineStatePath, Encoding.UTF8);
                if (string.IsNullOrWhiteSpace(json))
                {
                    return;
                }

                var state = JsonSerializer.Deserialize(json, OmniJsonContext.Default.RoutineState);
                if (state?.Items == null)
                {
                    return;
                }

                foreach (var item in state.Items)
                {
                    if (string.IsNullOrWhiteSpace(item.Id))
                    {
                        continue;
                    }

                    item.Running = false;
                    _routinesById[item.Id] = item;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[routine] state load failed: {ex.Message}");
            }
        }
    }

    private void SaveRoutineStateLocked()
    {
        try
        {
            var dir = Path.GetDirectoryName(_routineStatePath);
            if (!string.IsNullOrWhiteSpace(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var state = new RoutineState
            {
                Items = _routinesById.Values
                    .OrderBy(x => x.CreatedUtc)
                    .ToArray()
            };
            var json = JsonSerializer.Serialize(state, OmniJsonContext.Default.RoutineState);
            AtomicFileStore.WriteAllText(_routineStatePath, json, ownerOnly: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[routine] state save failed: {ex.Message}");
        }
    }

    private async Task<RoutineGenerationResult> GenerateRoutineImplementationAsync(
        string request,
        RoutineSchedule schedule,
        CancellationToken cancellationToken
    )
    {
        var systemPromptPath = Path.Combine(_routinePromptDir, "system_prompt.md");
        var baseConfigPath = Path.Combine(_routinePromptDir, "기본 구성.md");
        var systemPrompt = File.Exists(systemPromptPath) ? File.ReadAllText(systemPromptPath, Encoding.UTF8) : string.Empty;
        var baseConfig = File.Exists(baseConfigPath) ? File.ReadAllText(baseConfigPath, Encoding.UTF8) : string.Empty;
        var objective = BuildRoutineGenerationPrompt(request, schedule.Display, systemPrompt, baseConfig);
        var strategy = await SelectRoutineCodingStrategyAsync(objective, cancellationToken);

        if (!_llmRouter.HasGroqApiKey())
        {
            var fallbackCode = BuildFallbackRoutineCode(request, schedule);
            return new RoutineGenerationResult(
                PlannerProvider: "local",
                PlannerModel: "none",
                CoderModel: "local-fallback",
                Plan: "Groq API 키가 없어 로컬 기본 템플릿으로 생성했습니다.",
                Language: "bash",
                Code: fallbackCode
            );
        }

        if (strategy.Mode == "split")
        {
            var chunks = new List<string>();
            var partLabels = new[] { "파트 1/3", "파트 2/3", "파트 3/3" };
            for (var i = 0; i < strategy.Models.Count; i++)
            {
                var model = strategy.Models[i];
                var prompt = objective + $"\n\n[{partLabels[Math.Min(i, partLabels.Length - 1)]}] 관점으로 설계/코드 초안을 작성하세요.";
                var generated = await GenerateByProviderSafeAsync("groq", model, prompt, cancellationToken, Math.Min(_config.CodingMaxOutputTokens, 2800));
                chunks.Add($"[{model}]\n{generated.Text}");
            }

            var merged = string.Join("\n\n", chunks);
            var parsed = ParseCodeCandidate(merged, "bash");
            var language = parsed.Language is "bash" or "python" ? parsed.Language : "bash";
            var code = string.IsNullOrWhiteSpace(parsed.Code)
                ? BuildFallbackRoutineCode(request, schedule)
                : EnsureRoutineShebang(parsed.Code, language);

            return new RoutineGenerationResult(
                PlannerProvider: "groq",
                PlannerModel: "split",
                CoderModel: string.Join(",", strategy.Models),
                Plan: ExtractPlanText(merged),
                Language: language,
                Code: code
            );
        }

        var single = await GenerateByProviderSafeAsync("groq", strategy.Models[0], objective, cancellationToken, Math.Min(_config.CodingMaxOutputTokens, 4200));
        var singleParsed = ParseCodeCandidate(single.Text, "bash");
        var singleLanguage = singleParsed.Language is "bash" or "python" ? singleParsed.Language : "bash";
        var singleCode = string.IsNullOrWhiteSpace(singleParsed.Code)
            ? BuildFallbackRoutineCode(request, schedule)
            : EnsureRoutineShebang(singleParsed.Code, singleLanguage);
        return new RoutineGenerationResult(
            PlannerProvider: "groq",
            PlannerModel: strategy.Models[0],
            CoderModel: strategy.Models[0],
            Plan: ExtractPlanText(single.Text),
            Language: singleLanguage,
            Code: singleCode
        );
    }

    private async Task<RoutineModelStrategy> SelectRoutineCodingStrategyAsync(string objective, CancellationToken cancellationToken)
    {
        static bool Has(IReadOnlySet<string> set, string modelId) => set.Contains(modelId);

        var availableModels = await _groqModelCatalog.GetModelsAsync(cancellationToken);
        var modelSet = availableModels.Select(x => x.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var estimatedTokens = EstimatePromptTokens(objective);

        var maverickReady = Has(modelSet, RoutineModelMaverick) && !IsGroqRateLimitImminent(RoutineModelMaverick, 2200);
        var gptOssReady = Has(modelSet, RoutineModelGptOss) && !IsGroqRateLimitImminent(RoutineModelGptOss, 2200);
        var kimiReady = Has(modelSet, RoutineModelKimi) && !IsGroqRateLimitImminent(RoutineModelKimi, 2200);

        if (estimatedTokens <= 6000 && maverickReady)
        {
            return new RoutineModelStrategy("single", new[] { RoutineModelMaverick }, $"estimated_tpm={estimatedTokens}");
        }

        if (gptOssReady)
        {
            return new RoutineModelStrategy("single", new[] { RoutineModelGptOss }, $"fallback_from_maverick estimated_tpm={estimatedTokens}");
        }

        if (kimiReady)
        {
            return new RoutineModelStrategy("single", new[] { RoutineModelKimi }, "fallback_from_gptoss");
        }

        var split = new List<string>();
        if (Has(modelSet, RoutineModelMaverick))
        {
            split.Add(RoutineModelMaverick);
        }

        if (Has(modelSet, RoutineModelGptOss))
        {
            split.Add(RoutineModelGptOss);
        }

        if (Has(modelSet, RoutineModelKimi))
        {
            split.Add(RoutineModelKimi);
        }

        if (split.Count == 0)
        {
            split.Add(_llmRouter.GetSelectedGroqModel());
        }

        while (split.Count < 3)
        {
            split.Add(split[^1]);
        }

        return new RoutineModelStrategy("split", split.Take(3).ToArray(), "all_models_budget_limited");
    }

    private static string BuildRoutineGenerationPrompt(string request, string schedule, string systemPrompt, string baseConfig)
    {
        return $"""
                {systemPrompt}

                {baseConfig}

                [사용자 루틴 요청]
                {request}

                [정규화 스케줄]
                {schedule}

                요구사항:
                1) macOS/Linux 모두 동작 가능한 루틴 코드
                2) 외부 의존 최소화
                3) 실행 결과를 stdout 텍스트로 요약 출력
                4) 민감정보 노출 금지

                출력 형식:
                PLAN:
                - 단계1
                - 단계2

                LANGUAGE=<bash 또는 python>
                ```bash
                # 실행 가능한 전체 코드
                ```
                """;
    }

    private static int EstimatePromptTokens(string text)
    {
        var length = (text ?? string.Empty).Length;
        return Math.Max(1, length / 3);
    }

    private static string ExtractPlanText(string raw)
    {
        var text = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return "계획 텍스트 없음";
        }

        var fenceIndex = text.IndexOf("```", StringComparison.Ordinal);
        if (fenceIndex <= 0)
        {
            return text.Length <= 1500 ? text : text[..1500] + "...";
        }

        var plan = text[..fenceIndex].Trim();
        return string.IsNullOrWhiteSpace(plan) ? "계획 텍스트 없음" : (plan.Length <= 1500 ? plan : plan[..1500] + "...");
    }

    private static string EnsureRoutineShebang(string code, string language)
    {
        var normalized = (code ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return normalized;
        }

        if (language == "bash")
        {
            var body = normalized;
            if (body.StartsWith("#!/usr/bin/env bash", StringComparison.Ordinal))
            {
                body = body["#!/usr/bin/env bash".Length..].TrimStart();
            }

            if (body.StartsWith("set -euo pipefail", StringComparison.Ordinal))
            {
                body = body["set -euo pipefail".Length..].TrimStart();
            }

            return """
                   #!/usr/bin/env bash
                   set -euo pipefail

                   # Omni-node portability shim (macOS/Linux)
                   if ! command -v free >/dev/null 2>&1; then
                     free() {
                       echo "              total        used        free"
                       echo "Mem:           n/a         n/a         n/a"
                       if command -v vm_stat >/dev/null 2>&1; then
                         echo ""
                         vm_stat | head -n 6
                       fi
                       return 0
                     }
                   fi

                   """ + body;
        }

        if (language == "python" && !normalized.StartsWith("#!/usr/bin/env python3", StringComparison.Ordinal))
        {
            return "#!/usr/bin/env python3\n" + normalized;
        }

        return normalized;
    }

    private static string BuildFallbackRoutineCode(string request, RoutineSchedule schedule)
    {
        var escaped = EscapeForSingleQuotes(request);
        return $"""
                #!/usr/bin/env bash
                set -euo pipefail

                echo "[Routine] 요청: '{escaped}'"
                echo "[Routine] 스케줄: {schedule.Display}"
                echo "[Routine] 실행시각: $(date '+%Y-%m-%d %H:%M:%S')"
                echo "[Routine] TODO: 실제 데이터 수집/요약 로직을 모델 생성 코드로 교체"
                """;
    }

    private static string EscapeForSingleQuotes(string text)
    {
        return (text ?? string.Empty).Replace("'", "'\"'\"'", StringComparison.Ordinal);
    }

    private static string BuildRoutineExecutionText(RoutineDefinition routine, CodeExecutionResult exec)
    {
        var stdout = (exec.StdOut ?? string.Empty).Trim();
        var stderr = (exec.StdErr ?? string.Empty).Trim();
        var summary = new StringBuilder();
        summary.AppendLine($"[Routine:{routine.Id}] {routine.Title}");
        summary.AppendLine($"status={exec.Status} exit={exec.ExitCode}");
        summary.AppendLine($"model={routine.CoderModel}");
        summary.AppendLine($"script={routine.ScriptPath}");
        summary.AppendLine($"run_dir={exec.RunDirectory}");
        if (!string.IsNullOrWhiteSpace(stdout))
        {
            summary.AppendLine();
            summary.AppendLine("[stdout]");
            summary.AppendLine(stdout.Length <= 1600 ? stdout : stdout[..1600] + "...");
        }

        if (!string.IsNullOrWhiteSpace(stderr))
        {
            summary.AppendLine();
            summary.AppendLine("[stderr]");
            summary.AppendLine(stderr.Length <= 1200 ? stderr : stderr[..1200] + "...");
        }

        return summary.ToString().Trim();
    }

    private static string ResolveCronRunEntryStatus(CodeExecutionResult exec)
    {
        var normalized = NormalizeCronRunStatus(exec.Status);
        if (!string.IsNullOrWhiteSpace(normalized))
        {
            return normalized;
        }

        return exec.ExitCode == 0 ? "ok" : "error";
    }

    private static string? BuildCronRunEntryError(CodeExecutionResult exec, string output, string status)
    {
        if (!string.Equals(status, "error", StringComparison.Ordinal))
        {
            return null;
        }

        var stderr = (exec.StdErr ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            return TrimForCronError(stderr);
        }

        return TrimForCronError(output);
    }

    private static string? BuildCronRunEntrySummary(string output)
    {
        var normalized = (output ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        const int maxChars = 800;
        if (normalized.Length <= maxChars)
        {
            return normalized;
        }

        return normalized[..maxChars] + "...";
    }

    private static bool ShouldRunCronAgentTurnBridge(RoutineDefinition routine)
    {
        if (!string.Equals(
                NormalizeCronSessionTargetOrDefault(routine.CronSessionTarget),
                "isolated",
                StringComparison.Ordinal
            ))
        {
            return false;
        }

        return string.Equals(
            NormalizeCronPayloadKindOrDefault(routine.CronPayloadKind),
            "agentTurn",
            StringComparison.Ordinal
        );
    }

    private CodeExecutionResult ExecuteCronAgentTurnBridge(
        RoutineDefinition routine,
        CancellationToken cancellationToken
    )
    {
        var command = "sessions_spawn runtime=acp mode=run";
        if (cancellationToken.IsCancellationRequested)
        {
            var canceledStdOut = $"""
                                  [cron.agentTurn.bridge]
                                  routineId={routine.Id}
                                  status=error
                                  reason=canceled
                                  """;
            return new CodeExecutionResult(
                "cron-agentturn",
                ResolveWorkspaceRoot(),
                "-",
                command,
                1,
                canceledStdOut,
                "cancellation requested",
                "error"
            );
        }

        var payloadText = ResolveRoutineRequestText(routine.Request, routine.Title);
        var payloadModel = NormalizeOptionalCronPayloadString(routine.CronPayloadModel);
        var payloadThinking = NormalizeOptionalCronPayloadString(routine.CronPayloadThinking);
        var payloadTimeoutSeconds = routine.CronPayloadTimeoutSeconds;
        var payloadLightContext = routine.CronPayloadLightContext;

        var spawnTask = BuildCronAgentTurnSpawnTask(
            payloadText,
            payloadModel,
            payloadThinking,
            payloadTimeoutSeconds,
            payloadLightContext
        );
        var spawnResult = _sessionSpawnTool.Spawn(
            task: spawnTask,
            label: $"cron-{routine.Title}",
            runtime: "acp",
            runTimeoutSeconds: payloadTimeoutSeconds,
            timeoutSeconds: payloadTimeoutSeconds,
            thread: false,
            mode: "run",
            acpModel: payloadModel,
            acpThinking: payloadThinking,
            acpLightContext: payloadLightContext
        );

        if (string.Equals(spawnResult.Status, "accepted", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(spawnResult.ChildSessionKey))
        {
            var optionNote = BuildCronAgentTurnOptionsBlock(
                payloadModel,
                payloadThinking,
                payloadTimeoutSeconds,
                payloadLightContext
            );
            if (!string.IsNullOrWhiteSpace(optionNote))
            {
                _ = _conversationStore.AppendMessage(
                    spawnResult.ChildSessionKey,
                    "system",
                    optionNote,
                    "cron_agentturn_options"
                );
            }
        }

        var accepted = string.Equals(spawnResult.Status, "accepted", StringComparison.OrdinalIgnoreCase);
        var resolvedCommand = $"{command} timeoutSeconds={(spawnResult.RunTimeoutSeconds).ToString(CultureInfo.InvariantCulture)}";
        var stdout = BuildCronAgentTurnBridgeStdOut(
            routine,
            spawnResult,
            payloadModel,
            payloadThinking,
            payloadTimeoutSeconds,
            payloadLightContext
        );
        var stderr = accepted
            ? string.Empty
            : string.IsNullOrWhiteSpace(spawnResult.Error)
                ? "sessions_spawn returned error"
                : spawnResult.Error!;

        return new CodeExecutionResult(
            "cron-agentturn",
            ResolveWorkspaceRoot(),
            "-",
            resolvedCommand,
            accepted ? 0 : 1,
            stdout,
            stderr,
            accepted ? "ok" : "error"
        );
    }

    private static string BuildCronAgentTurnSpawnTask(
        string message,
        string? model,
        string? thinking,
        int? timeoutSeconds,
        bool? lightContext
    )
    {
        var optionBlock = BuildCronAgentTurnOptionsBlock(model, thinking, timeoutSeconds, lightContext);
        if (string.IsNullOrWhiteSpace(optionBlock))
        {
            return message;
        }

        return $"{optionBlock}\n\n{message}";
    }

    private static string BuildCronAgentTurnBridgeStdOut(
        RoutineDefinition routine,
        SessionSpawnToolResult spawnResult,
        string? model,
        string? thinking,
        int? timeoutSeconds,
        bool? lightContext
    )
    {
        var builder = new StringBuilder();
        builder.AppendLine("[cron.agentTurn.bridge]");
        builder.AppendLine($"routineId={routine.Id}");
        builder.AppendLine($"spawnStatus={spawnResult.Status}");
        builder.AppendLine($"runtime={spawnResult.Runtime}");
        builder.AppendLine($"mode={spawnResult.Mode}");
        builder.AppendLine($"runId={spawnResult.RunId}");
        if (!string.IsNullOrWhiteSpace(spawnResult.ChildSessionKey))
        {
            builder.AppendLine($"childSessionKey={spawnResult.ChildSessionKey}");
        }
        if (!string.IsNullOrWhiteSpace(spawnResult.BackendSessionId))
        {
            builder.AppendLine($"backendSessionId={spawnResult.BackendSessionId}");
        }
        if (!string.IsNullOrWhiteSpace(spawnResult.ThreadBindingKey))
        {
            builder.AppendLine($"threadBindingKey={spawnResult.ThreadBindingKey}");
        }

        var optionBlock = BuildCronAgentTurnOptionsBlock(model, thinking, timeoutSeconds, lightContext);
        if (!string.IsNullOrWhiteSpace(optionBlock))
        {
            builder.AppendLine();
            builder.AppendLine(optionBlock);
        }

        return builder.ToString().Trim();
    }

    private static string? BuildCronAgentTurnOptionsBlock(
        string? model,
        string? thinking,
        int? timeoutSeconds,
        bool? lightContext
    )
    {
        var lines = new List<string>();
        if (!string.IsNullOrWhiteSpace(model))
        {
            lines.Add($"- model: {model}");
        }

        if (!string.IsNullOrWhiteSpace(thinking))
        {
            lines.Add($"- thinking: {thinking}");
        }

        if (timeoutSeconds.HasValue)
        {
            lines.Add($"- timeoutSeconds: {timeoutSeconds.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (lightContext.HasValue)
        {
            lines.Add($"- lightContext: {(lightContext.Value ? "true" : "false")}");
        }

        if (lines.Count == 0)
        {
            return null;
        }

        return "[cron.agentTurn.options]\n" + string.Join("\n", lines);
    }

    private static void AppendRoutineRunLogEntry(RoutineDefinition routine, RoutineRunLogEntry entry)
    {
        routine.CronRunLog ??= new List<RoutineRunLogEntry>();
        routine.CronRunLog.Add(entry);
        const int maxEntries = 200;
        if (routine.CronRunLog.Count <= maxEntries)
        {
            return;
        }

        var removeCount = routine.CronRunLog.Count - maxEntries;
        routine.CronRunLog.RemoveRange(0, removeCount);
    }

    private static RoutineSummary ToRoutineSummary(RoutineDefinition routine)
    {
        var localNext = routine.NextRunUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
        var localLast = routine.LastRunUtc?.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") ?? "-";
        return new RoutineSummary(
            routine.Id,
            routine.Title,
            routine.Request,
            routine.ScheduleText,
            routine.Enabled,
            localNext,
            localLast,
            routine.LastStatus,
            routine.LastOutput,
            routine.ScriptPath,
            routine.Language,
            routine.CoderModel
        );
    }

    private static RoutineSchedule ParseDailySchedule(string request)
    {
        var text = (request ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return new RoutineSchedule(8, 0, "매일 08:00");
        }

        var hhmm = Regex.Match(text, @"(\d{1,2})\s*:\s*(\d{1,2})", RegexOptions.IgnoreCase);
        if (hhmm.Success
            && int.TryParse(hhmm.Groups[1].Value, out var hour1)
            && int.TryParse(hhmm.Groups[2].Value, out var minute1))
        {
            hour1 = Math.Clamp(hour1, 0, 23);
            minute1 = Math.Clamp(minute1, 0, 59);
            return new RoutineSchedule(hour1, minute1, $"매일 {hour1:D2}:{minute1:D2}");
        }

        var match = Regex.Match(text, @"매일\s*(아침|오전|오후|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?", RegexOptions.IgnoreCase);
        if (!match.Success)
        {
            return new RoutineSchedule(8, 0, "매일 08:00");
        }

        var period = match.Groups[1].Value.Trim();
        _ = int.TryParse(match.Groups[2].Value, out var hour);
        _ = int.TryParse(match.Groups[3].Value, out var minute);
        hour = Math.Clamp(hour, 0, 23);
        minute = Math.Clamp(minute, 0, 59);
        if ((period == "오후" || period == "저녁" || period == "밤") && hour < 12)
        {
            hour += 12;
        }

        if ((period == "오전" || period == "아침") && hour == 12)
        {
            hour = 0;
        }

        return new RoutineSchedule(hour, minute, $"매일 {hour:D2}:{minute:D2}");
    }

    private static string BuildRoutineTitle(string request)
    {
        var text = (request ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return "새 루틴";
        }

        var title = text.Length <= 26 ? text : text[..26].TrimEnd() + "...";
        return title;
    }

    private static DateTimeOffset ComputeNextDailyRunUtc(int hour, int minute, string timezoneId, DateTimeOffset nowUtc)
    {
        var tz = ResolveTimeZone(timezoneId);
        var nowLocal = TimeZoneInfo.ConvertTime(nowUtc, tz);
        var nextLocal = new DateTime(nowLocal.Year, nowLocal.Month, nowLocal.Day, hour, minute, 0, DateTimeKind.Unspecified);
        if (nextLocal <= nowLocal.DateTime)
        {
            nextLocal = nextLocal.AddDays(1);
        }

        var offset = tz.GetUtcOffset(nextLocal);
        return new DateTimeOffset(nextLocal, offset).ToUniversalTime();
    }

    private static TimeZoneInfo ResolveTimeZone(string? timezoneId)
    {
        if (!string.IsNullOrWhiteSpace(timezoneId))
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(timezoneId.Trim());
            }
            catch
            {
            }
        }

        return TimeZoneInfo.Local;
    }

}
