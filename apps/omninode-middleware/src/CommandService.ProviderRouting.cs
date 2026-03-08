using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private async Task<LlmSingleChatResult> GenerateByProviderAsync(
        string provider,
        string? model,
        string input,
        CancellationToken cancellationToken,
        int? maxOutputTokens = null,
        bool useRawCodexPrompt = false
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

        if (normalized == "codex")
        {
            var selected = NormalizeModelSelection(model) ?? _config.CodexModel;
            var response = await _codexWrapper.GenerateChatAsync(
                input,
                selected,
                cancellationToken,
                useChatEnvelope: !useRawCodexPrompt
            );
            return new LlmSingleChatResult("codex", selected, response);
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
        int? maxOutputTokens = null,
        bool useRawCodexPrompt = false
    )
    {
        var normalized = NormalizeProvider(provider, allowAuto: false);
        var effectiveModel = normalized == "groq"
            ? ResolveGroqModelForInput(input, model)
            : ResolveProviderModel(normalized, model);
        var timeoutSeconds = normalized switch
        {
            "copilot" => Math.Max(120, _config.LlmTimeoutSec * 3),
            "codex" => Math.Max(120, _config.LlmTimeoutSec * 3),
            "cerebras" => Math.Max(8, _config.CerebrasTimeoutSec),
            _ => Math.Max(8, _config.LlmTimeoutSec)
        };
        var maxAttempts = normalized == "gemini" ? 2 : 1;
        LlmSingleChatResult? lastResult = null;
        Exception? lastException = null;

        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

            try
            {
                lastResult = await GenerateByProviderAsync(
                    normalized,
                    model,
                    input,
                    timeoutCts.Token,
                    maxOutputTokens,
                    useRawCodexPrompt
                );
                lastException = null;
                if (normalized == "gemini"
                    && attempt < maxAttempts
                    && ShouldRetryTransientGeminiFailure(lastResult.Text))
                {
                    Console.Error.WriteLine(
                        $"[gemini] transient failure detected, retrying once (attempt={attempt}, model={effectiveModel})"
                    );
                    await Task.Delay(250, cancellationToken);
                    continue;
                }

                return lastResult;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                lastResult = new LlmSingleChatResult(normalized, effectiveModel, $"{normalized} 응답 시간이 초과되었습니다.");
                lastException = null;
                if (normalized == "gemini" && attempt < maxAttempts)
                {
                    Console.Error.WriteLine(
                        $"[gemini] provider timeout detected, retrying once (attempt={attempt}, model={effectiveModel})"
                    );
                    await Task.Delay(250, cancellationToken);
                    continue;
                }

                return lastResult;
            }
            catch (Exception ex)
            {
                lastException = ex;
                if (normalized == "gemini" && attempt < maxAttempts)
                {
                    Console.Error.WriteLine(
                        $"[gemini] provider exception detected, retrying once (attempt={attempt}, model={effectiveModel}, error={ex.Message})"
                    );
                    await Task.Delay(250, cancellationToken);
                    continue;
                }

                break;
            }
        }

        if (lastResult != null)
        {
            return lastResult;
        }

        return new LlmSingleChatResult(
            normalized,
            effectiveModel,
            $"{normalized} 호출 오류: {lastException?.Message ?? "unknown"}"
        );
    }

    private static bool ShouldRetryTransientGeminiFailure(string? text)
    {
        var normalized = (text ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return normalized.StartsWith("gemini 호출 오류:", StringComparison.Ordinal)
               && (normalized.Contains("the operation was canceled", StringComparison.Ordinal)
                   || normalized.Contains("the operation was cancelled", StringComparison.Ordinal))
            || normalized.StartsWith("gemini 응답 시간이 초과되었습니다.", StringComparison.Ordinal);
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
        if (value == "gemini" || value == "groq" || value == "cerebras" || value == "copilot" || value == "codex")
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
        string? copilotModel,
        string? codexModel
    )
    {
        return new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["gemini"] = geminiModel,
            ["groq"] = groqModel,
            ["cerebras"] = cerebrasModel,
            ["copilot"] = copilotModel,
            ["codex"] = codexModel
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
        var priority = new[] { "gemini", "groq", "cerebras", "copilot", "codex" };
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
}
