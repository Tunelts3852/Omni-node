using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private const double NaturalCommandMinConfidence = 0.72d;
    private const int NaturalCommandInterpretMaxTokens = 260;

    private async Task<string?> TryHandleUnifiedSlashCommandAsync(
        string text,
        string source,
        CancellationToken cancellationToken
    )
    {
        var normalized = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized) || !normalized.StartsWith("/", StringComparison.Ordinal))
        {
            return null;
        }

        var tokens = normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 0)
        {
            return null;
        }

        var head = tokens[0].Trim().ToLowerInvariant();
        if (head is "/talk" or "/code")
        {
            var profile = head == "/talk" ? "talk" : "code";
            var thinking = tokens.Length >= 2 ? NormalizeThinkingLevel(tokens[1], "auto") : "auto";
            return ApplyChannelProfile(source, profile, thinking);
        }

        if (head == "/profile")
        {
            if (tokens.Length < 2)
            {
                return "usage: /profile <talk|code> [low|high]";
            }

            var profile = tokens[1].Trim().ToLowerInvariant();
            if (profile is not ("talk" or "code"))
            {
                return "invalid profile. use talk|code";
            }

            var thinking = tokens.Length >= 3 ? NormalizeThinkingLevel(tokens[2], "auto") : "auto";
            return ApplyChannelProfile(source, profile, thinking);
        }

        if (head == "/mode")
        {
            if (tokens.Length < 2)
            {
                return "usage: /mode <single|orchestration|multi>";
            }

            return SetChannelMode(source, tokens[1].Trim().ToLowerInvariant());
        }

        if (head == "/provider")
        {
            if (tokens.Length < 3)
            {
                return "usage: /provider <single|orchestration|summary> <groq|gemini|copilot|cerebras|auto>";
            }

            var slot = tokens[1].Trim().ToLowerInvariant();
            var provider = tokens[2].Trim().ToLowerInvariant();
            return SetChannelProvider(source, slot, provider);
        }

        if (head == "/model")
        {
            if (tokens.Length == 2)
            {
                var quickProvider = tokens[1].Trim().ToLowerInvariant();
                if (quickProvider is "groq" or "gemini" or "copilot" or "cerebras")
                {
                    return SetChannelProvider(source, "single", quickProvider);
                }
            }

            if (tokens.Length < 3)
            {
                return "usage: /model <single|orchestration|multi.groq|multi.copilot|multi.cerebras> <model-id>";
            }

            var slot = tokens[1].Trim().ToLowerInvariant();
            var modelId = string.Join(' ', tokens.Skip(2)).Trim();
            return SetChannelModel(source, slot, modelId);
        }

        if (head == "/status")
        {
            if (tokens.Length >= 2 && tokens[1].Trim().Equals("model", StringComparison.OrdinalIgnoreCase))
            {
                return BuildChannelModelStatus(source);
            }

            return "usage: /status model";
        }

        if (head == "/memory")
        {
            if (tokens.Length >= 2 && tokens[1].Equals("clear", StringComparison.OrdinalIgnoreCase))
            {
                var result = ClearMemory(source, source);
                return $"ok: {result}";
            }

            return "usage: /memory clear";
        }

        if (head == "/llm")
        {
            return await TryHandleUnifiedLlmCommandAsync(source, tokens, cancellationToken);
        }

        return null;
    }

    private async Task<string?> TryHandleUnifiedLlmCommandAsync(
        string source,
        IReadOnlyList<string> tokens,
        CancellationToken cancellationToken
    )
    {
        if (tokens.Count <= 1 || tokens[1].Equals("help", StringComparison.OrdinalIgnoreCase))
        {
            return BuildUnifiedLlmHelpText(source);
        }

        var sub = tokens[1].Trim().ToLowerInvariant();
        if (sub == "status")
        {
            return BuildChannelModelStatus(source);
        }

        if (sub is "usage" or "limits" or "quota")
        {
            return await BuildTelegramUsageReportAsync(cancellationToken);
        }

        if (sub == "mode")
        {
            if (tokens.Count < 3)
            {
                return "usage: /llm mode <single|orchestration|multi>";
            }

            return SetChannelMode(source, tokens[2].Trim().ToLowerInvariant());
        }

        if (sub == "single")
        {
            if (tokens.Count < 4)
            {
                return "usage: /llm single provider <groq|gemini|copilot|cerebras> | /llm single model <model-id>";
            }

            if (tokens[2].Equals("provider", StringComparison.OrdinalIgnoreCase))
            {
                return SetChannelProvider(source, "single", tokens[3].Trim().ToLowerInvariant());
            }

            if (tokens[2].Equals("model", StringComparison.OrdinalIgnoreCase))
            {
                var model = string.Join(' ', tokens.Skip(3)).Trim();
                return SetChannelModel(source, "single", model);
            }

            return "usage: /llm single provider <groq|gemini|copilot|cerebras> | /llm single model <model-id>";
        }

        if (sub == "orchestration")
        {
            if (tokens.Count < 4)
            {
                return "usage: /llm orchestration provider <auto|groq|gemini|copilot|cerebras> | /llm orchestration model <model-id>";
            }

            if (tokens[2].Equals("provider", StringComparison.OrdinalIgnoreCase))
            {
                return SetChannelProvider(source, "orchestration", tokens[3].Trim().ToLowerInvariant());
            }

            if (tokens[2].Equals("model", StringComparison.OrdinalIgnoreCase))
            {
                var model = string.Join(' ', tokens.Skip(3)).Trim();
                return SetChannelModel(source, "orchestration", model);
            }

            return "usage: /llm orchestration provider <auto|groq|gemini|copilot|cerebras> | /llm orchestration model <model-id>";
        }

        if (sub == "multi")
        {
            if (tokens.Count < 4)
            {
                return "usage: /llm multi groq <model-id> | /llm multi copilot <model-id> | /llm multi cerebras <model-id> | /llm multi summary <auto|groq|gemini|copilot|cerebras>";
            }

            var slot = tokens[2].Trim().ToLowerInvariant();
            if (slot == "summary")
            {
                return SetChannelProvider(source, "summary", tokens[3].Trim().ToLowerInvariant());
            }

            var model = string.Join(' ', tokens.Skip(3)).Trim();
            var canonicalSlot = slot switch
            {
                "groq" => "multi.groq",
                "copilot" => "multi.copilot",
                "cerebras" => "multi.cerebras",
                _ => string.Empty
            };

            if (string.IsNullOrWhiteSpace(canonicalSlot))
            {
                return "usage: /llm multi groq <model-id> | /llm multi copilot <model-id> | /llm multi cerebras <model-id> | /llm multi summary <auto|groq|gemini|copilot|cerebras>";
            }

            return SetChannelModel(source, canonicalSlot, model);
        }

        if (sub == "models")
        {
            var target = tokens.Count >= 3 ? tokens[2].Trim().ToLowerInvariant() : "all";
            return await BuildTelegramModelsReportAsync(target, cancellationToken);
        }

        if (sub == "set")
        {
            if (tokens.Count < 4)
            {
                return "usage: /llm set <groq|copilot> <model-id>";
            }

            var provider = tokens[2].Trim().ToLowerInvariant();
            var model = string.Join(' ', tokens.Skip(3)).Trim();
            if (provider == "groq")
            {
                var models = await _groqModelCatalog.GetModelsAsync(cancellationToken);
                if (!models.Any(x => x.Id.Equals(model, StringComparison.OrdinalIgnoreCase)))
                {
                    return $"알 수 없는 Groq 모델: {model}";
                }

                _llmRouter.TrySetSelectedGroqModel(model);
                var providerSet = SetChannelProvider(source, "single", "groq");
                if (providerSet.StartsWith("invalid", StringComparison.OrdinalIgnoreCase))
                {
                    return providerSet;
                }

                return SetChannelModel(source, "single", model);
            }

            if (provider == "copilot")
            {
                var models = await _copilotWrapper.GetModelsAsync(cancellationToken);
                if (!models.Any(x => x.Id.Equals(model, StringComparison.OrdinalIgnoreCase)))
                {
                    return $"알 수 없는 Copilot 모델: {model}";
                }

                if (!_copilotWrapper.TrySetSelectedModel(model))
                {
                    return $"Copilot 모델 설정 실패: {model}";
                }

                var providerSet = SetChannelProvider(source, "single", "copilot");
                if (providerSet.StartsWith("invalid", StringComparison.OrdinalIgnoreCase))
                {
                    return providerSet;
                }

                return SetChannelModel(source, "single", model);
            }

            return "usage: /llm set <groq|copilot> <model-id>";
        }

        return "unknown /llm command. use /llm help";
    }

    private async Task<string?> TryHandleNaturalCommandByLlmAsync(
        string source,
        string text,
        CancellationToken cancellationToken
    )
    {
        var normalized = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized) || normalized.StartsWith("/", StringComparison.Ordinal))
        {
            return null;
        }

        if (!source.Equals("telegram", StringComparison.OrdinalIgnoreCase)
            && !source.Equals("web", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (LooksLikeNaturalKillIntent(normalized))
        {
            return "보안 정책상 자연어 종료 요청은 허용되지 않습니다. /kill <pid> 형식으로만 실행할 수 있습니다.";
        }

        var interpretation = await ResolveNaturalCommandInterpretationAsync(source, normalized, cancellationToken);
        if (interpretation == null)
        {
            return null;
        }

        var validation = ValidateNaturalCommandInterpretation(interpretation, normalized);
        if (validation.IsChat)
        {
            return null;
        }

        if (!validation.Valid)
        {
            if (validation.Code == "natural_kill_disallowed")
            {
                return validation.Message;
            }

            return null;
        }

        if (validation.Canonical == null || string.IsNullOrWhiteSpace(validation.Canonical.SlashCommand))
        {
            return null;
        }

        var slashCommand = validation.Canonical.SlashCommand.Trim();
        if (!slashCommand.StartsWith("/", StringComparison.Ordinal))
        {
            return null;
        }

        _auditLogger.Log(
            source,
            "natural_command_resolved",
            "ok",
            $"cmd={NormalizeAuditToken(slashCommand, "-")} confidence={interpretation.Confidence.ToString("0.00", CultureInfo.InvariantCulture)}"
        );
        return await ExecuteAsync(slashCommand, source, cancellationToken);
    }

    private async Task<NaturalCommandInterpretation?> ResolveNaturalCommandInterpretationAsync(
        string source,
        string input,
        CancellationToken cancellationToken
    )
    {
        var selection = ResolveNaturalInterpretModelSelection(source, input);
        if (string.IsNullOrWhiteSpace(selection.Provider) || string.IsNullOrWhiteSpace(selection.Model))
        {
            return null;
        }

        var prompt = BuildNaturalCommandResolverPrompt(input);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromMilliseconds(Math.Clamp(_config.WebDecisionTimeoutMs + 900, 1000, 1800)));

        LlmSingleChatResult generated;
        try
        {
            generated = await GenerateByProviderAsync(
                selection.Provider,
                selection.Model,
                prompt,
                timeoutCts.Token,
                NaturalCommandInterpretMaxTokens
            );
        }
        catch
        {
            return null;
        }

        return TryParseNaturalCommandInterpretation(generated.Text, out var parsed)
            ? parsed
            : null;
    }

    private (string Provider, string Model) ResolveNaturalInterpretModelSelection(string source, string input)
    {
        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            TelegramLlmPreferences snapshot;
            lock (_telegramLlmLock)
            {
                snapshot = _telegramLlmPreferences.Clone();
            }

            return ResolveInterpretModelFromPreferences(
                snapshot.Mode,
                snapshot.SingleProvider,
                snapshot.SingleModel,
                snapshot.OrchestrationProvider,
                snapshot.OrchestrationModel,
                snapshot.MultiSummaryProvider,
                snapshot.MultiGroqModel,
                snapshot.MultiCopilotModel,
                snapshot.MultiCerebrasModel,
                input
            );
        }

        WebLlmPreferences webSnapshot;
        lock (_webLlmLock)
        {
            webSnapshot = _webLlmPreferences.Clone();
        }

        return ResolveInterpretModelFromPreferences(
            webSnapshot.Mode,
            webSnapshot.SingleProvider,
            webSnapshot.SingleModel,
            webSnapshot.OrchestrationProvider,
            webSnapshot.OrchestrationModel,
            webSnapshot.MultiSummaryProvider,
            webSnapshot.MultiGroqModel,
            webSnapshot.MultiCopilotModel,
            webSnapshot.MultiCerebrasModel,
            input
        );
    }

    private (string Provider, string Model) ResolveInterpretModelFromPreferences(
        string mode,
        string singleProvider,
        string singleModel,
        string orchestrationProvider,
        string orchestrationModel,
        string multiSummaryProvider,
        string multiGroqModel,
        string multiCopilotModel,
        string multiCerebrasModel,
        string input
    )
    {
        var normalizedMode = (mode ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedMode == "orchestration")
        {
            var provider = NormalizeProvider(orchestrationProvider, allowAuto: true);
            if (provider is "auto" or "none")
            {
                provider = "gemini";
            }

            return (provider, ResolveModel(provider, orchestrationModel));
        }

        if (normalizedMode == "multi")
        {
            var provider = NormalizeProvider(multiSummaryProvider, allowAuto: true);
            if (provider is "auto" or "none")
            {
                provider = "gemini";
            }

            var model = provider switch
            {
                "groq" => NormalizeModelSelection(multiGroqModel) ?? ResolveGroqModelForInput(input, null),
                "copilot" => NormalizeModelSelection(multiCopilotModel) ?? _copilotWrapper.GetSelectedModel(),
                "cerebras" => NormalizeModelSelection(multiCerebrasModel) ?? _config.CerebrasModel,
                _ => ResolveModel("gemini", null)
            };
            return (provider, model);
        }

        var single = NormalizeProvider(singleProvider, allowAuto: true);
        if (single is "auto" or "none")
        {
            single = "gemini";
        }

        var singleSelected = single == "groq"
            ? ResolveGroqModelForInput(input, singleModel)
            : ResolveModel(single, singleModel);
        return (single, singleSelected);
    }

    private static string BuildNaturalCommandResolverPrompt(string input)
    {
        var user = (input ?? string.Empty).Trim();
        return """
               당신은 omni-node 명령 해석기입니다.
               반드시 JSON 객체 하나만 출력하세요. 코드블록/설명/주석 금지.

               스키마:
               {
                 "kind": "command|chat",
                 "command": "mode.set|provider.set|model.set|profile.set|memory.clear|routine.list|routine.create|routine.run|routine.on|routine.off|routine.delete|metrics.get|llm.status|llm.usage|help.show|kill.request",
                 "args": {"k":"v"},
                 "confidence": 0.0,
                 "reason": "짧은 근거"
               }

               규칙:
               - 설정/제어 의도가 명확하면 kind=command.
               - 일반 질문/대화면 kind=chat.
               - pid 종료 의도는 command=kill.request 로만 표기.
               - args는 문자열 값만 사용.
               - profile.set args: profile=talk|code, thinking=low|high(선택)
               - mode.set args: mode=single|orchestration|multi
               - provider.set args: slot=single|orchestration|summary, provider=groq|gemini|copilot|cerebras|auto
               - model.set args: slot=single|orchestration|multi.groq|multi.copilot|multi.cerebras, model=<id>
               - help.show args: topic=llm|routine|natural (선택)
               - routine.create args: request=<원문>
               - routine.run/on/off/delete args: routine_id=<id>
               - confidence는 0~1

               사용자 입력:
               """
               + user;
    }

    private static bool TryParseNaturalCommandInterpretation(string raw, out NaturalCommandInterpretation interpretation)
    {
        interpretation = new NaturalCommandInterpretation("chat", string.Empty, new Dictionary<string, string>(), 0d, string.Empty);
        if (!TryExtractJsonObject(raw, out var json))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(NormalizeNaturalCommandJson(json));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var kind = TryReadJsonString(root, "kind");
            var command = TryReadJsonString(root, "command");
            var reason = TryReadJsonString(root, "reason");
            var confidence = TryReadJsonDouble(root, "confidence");
            var args = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (TryGetPropertyIgnoreCase(root, "args", out var argsElement)
                && argsElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in argsElement.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.String)
                    {
                        args[prop.Name] = (prop.Value.GetString() ?? string.Empty).Trim();
                        continue;
                    }

                    if (prop.Value.ValueKind == JsonValueKind.Number)
                    {
                        args[prop.Name] = prop.Value.GetRawText();
                        continue;
                    }

                    if (prop.Value.ValueKind == JsonValueKind.True || prop.Value.ValueKind == JsonValueKind.False)
                    {
                        args[prop.Name] = prop.Value.GetBoolean() ? "true" : "false";
                    }
                }
            }

            var normalizedKind = (kind ?? string.Empty).Trim().ToLowerInvariant();
            if (normalizedKind is not ("command" or "chat"))
            {
                normalizedKind = string.IsNullOrWhiteSpace(command) ? "chat" : "command";
            }

            if (confidence <= 0d)
            {
                confidence = normalizedKind == "command" ? 0.51d : 0.99d;
            }

            interpretation = new NaturalCommandInterpretation(
                normalizedKind,
                (command ?? string.Empty).Trim().ToLowerInvariant(),
                args,
                Math.Clamp(confidence, 0d, 1d),
                (reason ?? string.Empty).Trim()
            );
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string NormalizeNaturalCommandJson(string json)
    {
        var normalized = (json ?? string.Empty).Trim();
        normalized = normalized
            .Replace('“', '"')
            .Replace('”', '"')
            .Replace('’', '\'');
        normalized = JsonTrailingCommaRegex.Replace(normalized, "$1");
        return normalized;
    }

    private static bool TryExtractJsonObject(string raw, out string json)
    {
        json = string.Empty;
        var normalized = (raw ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        var fence = CodeFenceRegex.Match(normalized);
        if (fence.Success && fence.Groups.Count >= 3)
        {
            normalized = fence.Groups[2].Value.Trim();
        }

        var start = normalized.IndexOf('{');
        var end = normalized.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            return false;
        }

        json = normalized[start..(end + 1)];
        return true;
    }

    private static string? TryReadJsonString(JsonElement root, string property)
    {
        if (!TryGetPropertyIgnoreCase(root, property, out var value))
        {
            return null;
        }

        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    private static double TryReadJsonDouble(JsonElement root, string property)
    {
        if (!TryGetPropertyIgnoreCase(root, property, out var value))
        {
            return 0d;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var numeric))
        {
            return numeric;
        }

        if (value.ValueKind == JsonValueKind.String
            && double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }

        return 0d;
    }

    private static NaturalCommandValidationResult ValidateNaturalCommandInterpretation(
        NaturalCommandInterpretation interpretation,
        string rawInput
    )
    {
        if (interpretation == null)
        {
            return new NaturalCommandValidationResult(false, true, null, "empty", "empty interpretation");
        }

        if (interpretation.Kind == "chat")
        {
            return new NaturalCommandValidationResult(false, true, null, "chat", "chat intent");
        }

        if (interpretation.Confidence < NaturalCommandMinConfidence)
        {
            return new NaturalCommandValidationResult(false, false, null, "low_confidence", "confidence too low");
        }

        var command = NormalizeNaturalCommandKey(interpretation.Command);
        var args = interpretation.Args ?? new Dictionary<string, string>();

        string GetArg(params string[] keys)
        {
            foreach (var key in keys)
            {
                if (args.TryGetValue(key, out var found) && !string.IsNullOrWhiteSpace(found))
                {
                    return found.Trim();
                }
            }

            return string.Empty;
        }

        switch (command)
        {
            case "profile.set":
            {
                var profile = GetArg("profile", "name", "value").ToLowerInvariant();
                if (profile is not ("talk" or "code"))
                {
                    return new NaturalCommandValidationResult(false, false, null, "invalid_profile", "invalid profile");
                }

                var thinking = GetArg("thinking", "level").ToLowerInvariant();
                if (thinking is "low" or "high")
                {
                    return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/profile {profile} {thinking}"), "ok", string.Empty);
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/profile {profile}"), "ok", string.Empty);
            }
            case "mode.set":
            {
                var mode = GetArg("mode", "value").ToLowerInvariant();
                if (mode is not ("single" or "orchestration" or "multi"))
                {
                    return new NaturalCommandValidationResult(false, false, null, "invalid_mode", "invalid mode");
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/mode {mode}"), "ok", string.Empty);
            }
            case "provider.set":
            {
                var slot = GetArg("slot", "target").ToLowerInvariant();
                var provider = GetArg("provider", "value").ToLowerInvariant();
                if (slot is not ("single" or "orchestration" or "summary"))
                {
                    return new NaturalCommandValidationResult(false, false, null, "invalid_provider_slot", "invalid provider slot");
                }

                if (provider is not ("groq" or "gemini" or "copilot" or "cerebras" or "auto"))
                {
                    return new NaturalCommandValidationResult(false, false, null, "invalid_provider", "invalid provider");
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/provider {slot} {provider}"), "ok", string.Empty);
            }
            case "model.set":
            {
                var slot = GetArg("slot", "target").ToLowerInvariant();
                var model = GetArg("model", "value");
                if (slot is not ("single" or "orchestration" or "multi.groq" or "multi.copilot" or "multi.cerebras"))
                {
                    return new NaturalCommandValidationResult(false, false, null, "invalid_model_slot", "invalid model slot");
                }

                if (string.IsNullOrWhiteSpace(model))
                {
                    return new NaturalCommandValidationResult(false, false, null, "missing_model", "model is required");
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/model {slot} {model}"), "ok", string.Empty);
            }
            case "memory.clear":
                if (!ContainsExplicitMemoryKeyword(rawInput))
                {
                    return new NaturalCommandValidationResult(false, false, null, "memory_keyword_required", "메모리 키워드가 필요합니다.");
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/memory clear"), "ok", string.Empty);
            case "routine.list":
                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/routine list"), "ok", string.Empty);
            case "routine.create":
            {
                var request = GetArg("request", "text", "value");
                if (string.IsNullOrWhiteSpace(request))
                {
                    return new NaturalCommandValidationResult(false, false, null, "missing_request", "routine request is required");
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/routine create {request}"), "ok", string.Empty);
            }
            case "routine.run":
            case "routine.on":
            case "routine.off":
            case "routine.delete":
            {
                var id = GetArg("routine_id", "id", "value");
                if (string.IsNullOrWhiteSpace(id))
                {
                    return new NaturalCommandValidationResult(false, false, null, "missing_routine_id", "routine id is required");
                }

                var action = command.Split('.')[1];
                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/routine {action} {id}"), "ok", string.Empty);
            }
            case "metrics.get":
                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/metrics"), "ok", string.Empty);
            case "llm.status":
                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/llm status"), "ok", string.Empty);
            case "llm.usage":
                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/llm usage"), "ok", string.Empty);
            case "help.show":
            {
                var topic = GetArg("topic", "value").ToLowerInvariant();
                if (string.IsNullOrWhiteSpace(topic))
                {
                    return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/help"), "ok", string.Empty);
                }

                if (topic is "llm" or "routine" or "natural")
                {
                    return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, $"/help {topic}"), "ok", string.Empty);
                }

                return new NaturalCommandValidationResult(true, false, new CanonicalCommand(command, "/help"), "ok", string.Empty);
            }
            case "kill.request":
                return new NaturalCommandValidationResult(
                    false,
                    false,
                    null,
                    "natural_kill_disallowed",
                    "보안 정책상 자연어 종료 요청은 허용되지 않습니다. /kill <pid> 형식으로만 실행할 수 있습니다."
                );
            default:
                return new NaturalCommandValidationResult(false, false, null, "unknown_command", "unknown command");
        }
    }

    private static string NormalizeNaturalCommandKey(string command)
    {
        var normalized = (command ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "mode" => "mode.set",
            "provider" => "provider.set",
            "model" => "model.set",
            "profile" => "profile.set",
            "memory" => "memory.clear",
            "routine" => "routine.list",
            "metrics" => "metrics.get",
            "status" => "llm.status",
            "usage" => "llm.usage",
            "help" => "help.show",
            "kill" => "kill.request",
            _ => normalized
        };
    }

    private static bool LooksLikeNaturalKillIntent(string text)
    {
        var normalized = (text ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return false;
        }

        return Regex.IsMatch(
            normalized,
            @"(?:pid|프로세스|process)\s*([0-9]{2,}).*(?:종료|kill|중지)|(?:종료|kill|중지).*(?:pid|프로세스|process)\s*([0-9]{2,})",
            RegexOptions.CultureInvariant
        );
    }

    private static bool ContainsExplicitMemoryKeyword(string text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        return normalized.Contains("메모리", StringComparison.OrdinalIgnoreCase);
    }

    private string ApplyChannelProfile(string source, string profile, string thinking)
    {
        var normalizedSource = (source ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedSource == "telegram")
        {
            lock (_telegramLlmLock)
            {
                if (profile == "talk")
                {
                    ApplyTelegramTalkDefaults(thinking);
                    return $"ok: profile=talk mode={_telegramLlmPreferences.Mode} thinking={_telegramLlmPreferences.TalkThinkingLevel}";
                }

                ApplyTelegramCodeDefaults(thinking);
                return $"ok: profile=code mode={_telegramLlmPreferences.Mode} thinking={_telegramLlmPreferences.CodeThinkingLevel}";
            }
        }

        lock (_webLlmLock)
        {
            if (profile == "talk")
            {
                ApplyWebTalkDefaults(thinking);
                return $"ok: profile=talk mode={_webLlmPreferences.Mode} thinking={_webLlmPreferences.TalkThinkingLevel}";
            }

            ApplyWebCodeDefaults(thinking);
            return $"ok: profile=code mode={_webLlmPreferences.Mode} thinking={_webLlmPreferences.CodeThinkingLevel}";
        }
    }

    private string SetChannelMode(string source, string mode)
    {
        if (mode is not ("single" or "orchestration" or "multi"))
        {
            return "invalid mode. use single|orchestration|multi";
        }

        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            lock (_telegramLlmLock)
            {
                _telegramLlmPreferences.Mode = mode;
            }

            return $"ok: telegram llm mode={mode}";
        }

        lock (_webLlmLock)
        {
            _webLlmPreferences.Mode = mode;
        }

        return $"ok: web llm mode={mode}";
    }

    private string SetChannelProvider(string source, string slot, string provider)
    {
        var normalizedSlot = (slot ?? string.Empty).Trim().ToLowerInvariant();
        var allowAuto = normalizedSlot is "orchestration" or "summary";
        var normalizedProvider = NormalizeProvider(provider, allowAuto);
        if (!allowAuto && normalizedProvider == "auto")
        {
            return "invalid provider. use groq|gemini|copilot|cerebras";
        }

        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            lock (_telegramLlmLock)
            {
                return SetTelegramProviderCore(normalizedSlot, normalizedProvider);
            }
        }

        lock (_webLlmLock)
        {
            return SetWebProviderCore(normalizedSlot, normalizedProvider);
        }
    }

    private string SetChannelModel(string source, string slot, string modelId)
    {
        var normalizedSlot = (slot ?? string.Empty).Trim().ToLowerInvariant();
        var normalizedModel = NormalizeModelSelection(modelId);
        if (string.IsNullOrWhiteSpace(normalizedModel))
        {
            return "model-id를 입력하세요.";
        }

        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            lock (_telegramLlmLock)
            {
                return SetTelegramModelCore(normalizedSlot, normalizedModel);
            }
        }

        lock (_webLlmLock)
        {
            return SetWebModelCore(normalizedSlot, normalizedModel);
        }
    }

    private string BuildChannelModelStatus(string source)
    {
        if (source.Equals("telegram", StringComparison.OrdinalIgnoreCase))
        {
            TelegramLlmPreferences snapshot;
            lock (_telegramLlmLock)
            {
                snapshot = _telegramLlmPreferences.Clone();
            }

            return BuildModelStatusText("telegram", snapshot.Mode, snapshot.SingleProvider, snapshot.SingleModel, snapshot.OrchestrationProvider, snapshot.OrchestrationModel, snapshot.MultiGroqModel, snapshot.MultiCopilotModel, snapshot.MultiCerebrasModel, snapshot.MultiSummaryProvider);
        }

        WebLlmPreferences webSnapshot;
        lock (_webLlmLock)
        {
            webSnapshot = _webLlmPreferences.Clone();
        }

        return BuildModelStatusText("web", webSnapshot.Mode, webSnapshot.SingleProvider, webSnapshot.SingleModel, webSnapshot.OrchestrationProvider, webSnapshot.OrchestrationModel, webSnapshot.MultiGroqModel, webSnapshot.MultiCopilotModel, webSnapshot.MultiCerebrasModel, webSnapshot.MultiSummaryProvider);
    }

    private static string BuildModelStatusText(
        string channel,
        string mode,
        string singleProvider,
        string singleModel,
        string orchestrationProvider,
        string orchestrationModel,
        string multiGroqModel,
        string multiCopilotModel,
        string multiCerebrasModel,
        string multiSummaryProvider
    )
    {
        return $"""
                [{channel.ToUpperInvariant()} LLM 상태]
                mode={mode}
                single={singleProvider}:{singleModel}
                orchestration={orchestrationProvider}:{orchestrationModel}
                multi.groq={multiGroqModel}
                multi.copilot={multiCopilotModel}
                multi.cerebras={multiCerebrasModel}
                multi.summary={multiSummaryProvider}
                """;
    }

    private string BuildUnifiedLlmHelpText(string source)
    {
        var channel = source.Equals("telegram", StringComparison.OrdinalIgnoreCase) ? "telegram" : "web";
        return $"""
                [LLM 제어 도움말:{channel}]
                - /profile <talk|code> [low|high]
                - /mode <single|orchestration|multi>
                - /provider <single|orchestration|summary> <groq|gemini|copilot|cerebras|auto>
                - /model <single|orchestration|multi.groq|multi.copilot|multi.cerebras> <model-id>
                - /status model
                - /llm status
                - /llm usage
                """;
    }

    private void ApplyWebTalkDefaults(string requestedThinking)
    {
        var fastModel = string.IsNullOrWhiteSpace(_config.GroqModel) ? DefaultGroqPrimaryModel : _config.GroqModel;
        _webLlmPreferences.Profile = "talk";
        _webLlmPreferences.Mode = "orchestration";
        _webLlmPreferences.SingleProvider = "groq";
        _webLlmPreferences.SingleModel = fastModel;
        _webLlmPreferences.AutoGroqComplexUpgrade = true;
        _webLlmPreferences.OrchestrationProvider = "gemini";
        _webLlmPreferences.OrchestrationModel = _config.GeminiModel;
        _webLlmPreferences.MultiGroqModel = fastModel;
        _webLlmPreferences.MultiCopilotModel = DefaultCopilotModel;
        _webLlmPreferences.MultiCerebrasModel = _config.CerebrasModel;
        _webLlmPreferences.MultiSummaryProvider = "gemini";
        _webLlmPreferences.TalkThinkingLevel = NormalizeThinkingLevel(requestedThinking, "low");
    }

    private void ApplyWebCodeDefaults(string requestedThinking)
    {
        var fastModel = string.IsNullOrWhiteSpace(_config.GroqModel) ? DefaultGroqPrimaryModel : _config.GroqModel;
        _webLlmPreferences.Profile = "code";
        _webLlmPreferences.Mode = "orchestration";
        _webLlmPreferences.SingleProvider = "copilot";
        _webLlmPreferences.SingleModel = DefaultCopilotModel;
        _webLlmPreferences.AutoGroqComplexUpgrade = false;
        _webLlmPreferences.OrchestrationProvider = "gemini";
        _webLlmPreferences.OrchestrationModel = _config.GeminiModel;
        _webLlmPreferences.MultiGroqModel = fastModel;
        _webLlmPreferences.MultiCopilotModel = DefaultCopilotModel;
        _webLlmPreferences.MultiCerebrasModel = _config.CerebrasModel;
        _webLlmPreferences.MultiSummaryProvider = "gemini";
        _webLlmPreferences.CodeThinkingLevel = NormalizeThinkingLevel(requestedThinking, "high");
    }

    private string SetTelegramProviderCore(string slot, string provider)
    {
        if (slot == "single")
        {
            _telegramLlmPreferences.SingleProvider = provider;
            if (provider == "groq")
            {
                _telegramLlmPreferences.SingleModel = string.IsNullOrWhiteSpace(_config.GroqModel) ? DefaultGroqPrimaryModel : _config.GroqModel;
                _telegramLlmPreferences.AutoGroqComplexUpgrade = true;
            }
            else if (provider == "copilot")
            {
                _telegramLlmPreferences.SingleModel = DefaultCopilotModel;
                _telegramLlmPreferences.AutoGroqComplexUpgrade = false;
            }
            else
            {
                _telegramLlmPreferences.SingleModel = provider == "cerebras"
                    ? _config.CerebrasModel
                    : _config.GeminiModel;
                _telegramLlmPreferences.AutoGroqComplexUpgrade = false;
            }

            return $"ok: telegram single provider={provider}";
        }

        if (slot == "orchestration")
        {
            _telegramLlmPreferences.OrchestrationProvider = provider;
            return $"ok: telegram orchestration provider={provider}";
        }

        if (slot == "summary")
        {
            _telegramLlmPreferences.MultiSummaryProvider = provider;
            return $"ok: telegram multi summary={provider}";
        }

        return "invalid provider slot. use single|orchestration|summary";
    }

    private string SetWebProviderCore(string slot, string provider)
    {
        if (slot == "single")
        {
            _webLlmPreferences.SingleProvider = provider;
            if (provider == "groq")
            {
                _webLlmPreferences.SingleModel = string.IsNullOrWhiteSpace(_config.GroqModel) ? DefaultGroqPrimaryModel : _config.GroqModel;
                _webLlmPreferences.AutoGroqComplexUpgrade = true;
            }
            else if (provider == "copilot")
            {
                _webLlmPreferences.SingleModel = DefaultCopilotModel;
                _webLlmPreferences.AutoGroqComplexUpgrade = false;
            }
            else
            {
                _webLlmPreferences.SingleModel = provider == "cerebras"
                    ? _config.CerebrasModel
                    : _config.GeminiModel;
                _webLlmPreferences.AutoGroqComplexUpgrade = false;
            }

            return $"ok: web single provider={provider}";
        }

        if (slot == "orchestration")
        {
            _webLlmPreferences.OrchestrationProvider = provider;
            return $"ok: web orchestration provider={provider}";
        }

        if (slot == "summary")
        {
            _webLlmPreferences.MultiSummaryProvider = provider;
            return $"ok: web multi summary={provider}";
        }

        return "invalid provider slot. use single|orchestration|summary";
    }

    private string SetTelegramModelCore(string slot, string model)
    {
        if (slot == "single")
        {
            _telegramLlmPreferences.SingleModel = model;
            if (_telegramLlmPreferences.SingleProvider == "groq")
            {
                _telegramLlmPreferences.AutoGroqComplexUpgrade = model.Equals(DefaultGroqFastModel, StringComparison.OrdinalIgnoreCase);
            }

            return $"ok: telegram single model={model}";
        }

        if (slot == "orchestration")
        {
            _telegramLlmPreferences.OrchestrationModel = model;
            return $"ok: telegram orchestration model={model}";
        }

        if (slot == "multi.groq")
        {
            _telegramLlmPreferences.MultiGroqModel = model;
            return $"ok: telegram multi groq={model}";
        }

        if (slot == "multi.copilot")
        {
            _telegramLlmPreferences.MultiCopilotModel = model;
            return $"ok: telegram multi copilot={model}";
        }

        if (slot == "multi.cerebras")
        {
            _telegramLlmPreferences.MultiCerebrasModel = model;
            return $"ok: telegram multi cerebras={model}";
        }

        return "invalid model slot. use single|orchestration|multi.groq|multi.copilot|multi.cerebras";
    }

    private string SetWebModelCore(string slot, string model)
    {
        if (slot == "single")
        {
            _webLlmPreferences.SingleModel = model;
            if (_webLlmPreferences.SingleProvider == "groq")
            {
                _webLlmPreferences.AutoGroqComplexUpgrade = model.Equals(DefaultGroqFastModel, StringComparison.OrdinalIgnoreCase);
            }

            return $"ok: web single model={model}";
        }

        if (slot == "orchestration")
        {
            _webLlmPreferences.OrchestrationModel = model;
            return $"ok: web orchestration model={model}";
        }

        if (slot == "multi.groq")
        {
            _webLlmPreferences.MultiGroqModel = model;
            return $"ok: web multi groq={model}";
        }

        if (slot == "multi.copilot")
        {
            _webLlmPreferences.MultiCopilotModel = model;
            return $"ok: web multi copilot={model}";
        }

        if (slot == "multi.cerebras")
        {
            _webLlmPreferences.MultiCerebrasModel = model;
            return $"ok: web multi cerebras={model}";
        }

        return "invalid model slot. use single|orchestration|multi.groq|multi.copilot|multi.cerebras";
    }
}
