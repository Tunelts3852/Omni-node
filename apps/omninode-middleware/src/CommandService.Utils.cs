using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private static readonly Regex PythonModuleNotFoundRegex = new("ModuleNotFoundError:\\s+No module named ['\\\"](?<module>[^'\\\"]+)['\\\"]", RegexOptions.Compiled);
    private static readonly Regex PythonImportErrorRegex = new("ImportError:\\s+No module named ['\\\"]?(?<module>[A-Za-z0-9_.-]+)['\\\"]?", RegexOptions.Compiled);
    private static readonly Regex NodeModuleNotFoundRegex = new("Cannot find module ['\\\"](?<module>[^'\\\"]+)['\\\"]|ERR_MODULE_NOT_FOUND[^'\\\"]*['\\\"](?<module2>[^'\\\"]+)['\\\"]", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex CommandNotFoundRegex = new("command not found:\\s*(?<cmd>[A-Za-z0-9][A-Za-z0-9+._-]{1,63})|(?<cmd2>[A-Za-z0-9][A-Za-z0-9+._-]{1,63}):\\s*(?:command\\s+not\\s+found|not\\s+found)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex PythonImportRegex = new("^\\s*import\\s+(?<mods>[A-Za-z0-9_.,\\s]+)", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex PythonFromImportRegex = new("^\\s*from\\s+(?<mod>[A-Za-z0-9_.]+)\\s+import\\s+", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex NodeImportRegex = new("from\\s+['\\\"](?<mod>[^'\\\"]+)['\\\"]|require\\(\\s*['\\\"](?<mod2>[^'\\\"]+)['\\\"]\\s*\\)|import\\(\\s*['\\\"](?<mod3>[^'\\\"]+)['\\\"]\\s*\\)", RegexOptions.Compiled);
    private static readonly Regex ShellTokenRegex = new("'(?<sq>[^']*)'|\"(?<dq>[^\"]*)\"|(?<bare>[^\\s]+)", RegexOptions.Compiled);
    private static readonly Dictionary<string, string> PythonModulePackageMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["cv2"] = "opencv-python",
        ["PIL"] = "pillow",
        ["yaml"] = "pyyaml",
        ["sklearn"] = "scikit-learn",
        ["bs4"] = "beautifulsoup4",
        ["dotenv"] = "python-dotenv",
        ["Crypto"] = "pycryptodome"
    };
    private static readonly HashSet<string> PythonStdlibModules = new(StringComparer.OrdinalIgnoreCase)
    {
        "abc","argparse","array","asyncio","base64","binascii","bisect","calendar","cmath","collections","concurrent","contextlib",
        "copy","csv","ctypes","dataclasses","datetime","decimal","difflib","dis","email","enum","errno","faulthandler","fnmatch",
        "fractions","functools","gc","getopt","getpass","gettext","glob","gzip","hashlib","heapq","hmac","html","http","imaplib",
        "importlib","inspect","io","ipaddress","itertools","json","linecache","locale","logging","lzma","math","mimetypes","multiprocessing",
        "numbers","operator","os","pathlib","pickle","pkgutil","platform","plistlib","pprint","queue","random","re","sched","secrets","select",
        "selectors","shelve","shlex","shutil","signal","site","socket","sqlite3","ssl","stat","statistics","string","stringprep","struct",
        "subprocess","sys","sysconfig","tarfile","tempfile","textwrap","threading","time","timeit","tkinter","_tkinter","tokenize","traceback","types","typing",
        "unittest","urllib","uuid","venv","warnings","wave","weakref","webbrowser","xml","xmlrpc","zipfile","zoneinfo","zlib"
    };
    private static readonly HashSet<string> NodeBuiltinModules = new(StringComparer.OrdinalIgnoreCase)
    {
        "assert","buffer","child_process","cluster","console","constants","crypto","dgram","diagnostics_channel","dns","domain","events",
        "fs","http","http2","https","inspector","module","net","os","path","perf_hooks","process","punycode","querystring","readline",
        "repl","stream","string_decoder","timers","tls","tty","url","util","v8","vm","wasi","worker_threads","zlib"
    };
    private static readonly HashSet<string> ProgramInstallDenyList = new(StringComparer.OrdinalIgnoreCase)
    {
        "bash","sh","zsh","sudo","env","python","python3","node","npm","npx","dotnet","java","javac","kotlinc","cc","c++","gcc","g++","git","ls","cat","echo","pwd"
    };
    private static readonly Regex MarkdownTableSeparatorCandidateRegex = new(
        @"^\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*(\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*)+\|$",
        RegexOptions.Compiled
    );
    private static readonly Regex MarkdownLooseSeparatorCellRegex = new(
        @"^:?-+:?$",
        RegexOptions.Compiled
    );

    private void RecordEvent(string message)
    {
        lock (_eventLock)
        {
            _recentEvents.Enqueue($"{DateTimeOffset.UtcNow:O} {message}");
            while (_recentEvents.Count > 50)
            {
                _recentEvents.Dequeue();
            }
        }
    }

    private string BuildContextSnapshot(string latestMetrics)
    {
        List<string> events;
        lock (_eventLock)
        {
            events = _recentEvents.ToList();
        }

        var builder = new System.Text.StringBuilder();
        builder.AppendLine("latest_metrics:");
        builder.AppendLine(latestMetrics);
        builder.AppendLine("recent_events:");
        foreach (var item in events)
        {
            builder.AppendLine(item);
        }
        return builder.ToString().Trim();
    }

    private async Task<string> ChatFallbackForUnknownAsync(string text, CancellationToken cancellationToken)
    {
        if (IsCopilotResponseTestPrompt(text))
        {
            return BuildMockCopilotTestResponse(_copilotWrapper.GetSelectedModel());
        }

        if (_llmRouter.HasGeminiApiKey())
        {
            return await _llmRouter.GenerateGeminiChatAsync(text, cancellationToken);
        }

        if (_llmRouter.HasGroqApiKey())
        {
            return await _llmRouter.GenerateGroqChatAsync(text, _llmRouter.GetSelectedGroqModel(), cancellationToken);
        }

        var copilotStatus = await _copilotWrapper.GetStatusAsync(cancellationToken);
        if (copilotStatus.Installed && copilotStatus.Authenticated)
        {
            return await _copilotWrapper.GenerateChatAsync(text, _copilotWrapper.GetSelectedModel(), cancellationToken);
        }

        return "LLM API 키(Groq/Gemini) 또는 Copilot 인증이 없어 일반 대화를 처리할 수 없습니다.";
    }

    private ConversationThreadView PrepareConversation(
        string scope,
        string mode,
        string? conversationId,
        string? conversationTitle,
        string? project,
        string? category,
        IReadOnlyList<string>? tags,
        IReadOnlyList<string>? linkedMemoryNotes
    )
    {
        var safeConversationId = conversationId;
        if (!string.IsNullOrWhiteSpace(safeConversationId))
        {
            var existing = _conversationStore.Get(safeConversationId.Trim());
            if (existing != null
                && (!existing.Scope.Equals(scope, StringComparison.OrdinalIgnoreCase)
                    || !existing.Mode.Equals(mode, StringComparison.OrdinalIgnoreCase)))
            {
                safeConversationId = null;
            }
        }

        var thread = _conversationStore.Ensure(scope, mode, safeConversationId, conversationTitle, project, category, tags);
        var mergedNotes = MergeMemoryNoteNames(thread.LinkedMemoryNotes, linkedMemoryNotes);
        if (mergedNotes.Count != thread.LinkedMemoryNotes.Count
            || mergedNotes.Except(thread.LinkedMemoryNotes, StringComparer.OrdinalIgnoreCase).Any())
        {
            thread = _conversationStore.SetLinkedMemoryNotes(thread.Id, mergedNotes);
        }

        return thread;
    }

    private SessionContext PrepareSessionContext(
        string scope,
        string mode,
        string? conversationId,
        string? conversationTitle,
        string? project,
        string? category,
        IReadOnlyList<string>? tags,
        IReadOnlyList<string>? linkedMemoryNotes,
        string? source
    )
    {
        var thread = PrepareConversation(
            scope,
            mode,
            conversationId,
            conversationTitle,
            project,
            category,
            tags,
            linkedMemoryNotes
        );
        return SessionContext.Create(thread, source);
    }

    private string BuildContextualInput(
        string conversationId,
        string input,
        IReadOnlyList<string>? requestMemoryNotes,
        bool includeLocalTimeHint = false
    )
    {
        var notes = MergeMemoryNoteNames(
            _conversationStore.Get(conversationId)?.LinkedMemoryNotes ?? Array.Empty<string>(),
            requestMemoryNotes
        );
        var noteBlocks = new List<string>();
        foreach (var name in notes.Take(4))
        {
            var read = _memoryNoteStore.Read(name);
            if (read == null)
            {
                continue;
            }

            var content = read.Content.Length > 900 ? read.Content[..900] + "\n...(truncated)" : read.Content;
            noteBlocks.Add($"### {name}\n{content}");
        }

        var historyRaw = _conversationStore.BuildHistoryText(conversationId, _config.ConversationHistoryMessages);
        var history = TrimContextHistory(historyRaw, 5200);
        var builder = new StringBuilder();
        builder.AppendLine("[컨텍스트 사용 규칙]");
        builder.AppendLine("- '새 요청'을 최우선으로 처리하세요.");
        builder.AppendLine("- 최근 대화/메모리와 새 요청이 충돌하면 새 요청을 따르세요.");
        builder.AppendLine("- 이전 답변 형식(예: 뉴스 N건 목록)을 관성으로 복사하지 마세요.");
        builder.AppendLine();
        if (noteBlocks.Count > 0)
        {
            builder.AppendLine("[공유 메모리 노트]");
            builder.AppendLine(string.Join("\n\n", noteBlocks));
            builder.AppendLine();
        }

        if (!string.IsNullOrWhiteSpace(history))
        {
            builder.AppendLine("[최근 대화]");
            builder.AppendLine(history);
            builder.AppendLine();
        }

        if (includeLocalTimeHint && LooksLikeLocalDateTimeQuestion(input))
        {
            builder.AppendLine("[로컬 시간]");
            builder.AppendLine(BuildLocalNowText());
            builder.AppendLine("- 현재 시각/날짜/요일/타임존 관련 질문은 위 로컬 시간을 기준으로 답하세요.");
            builder.AppendLine();
        }

        builder.AppendLine("[새 요청]");
        builder.AppendLine(input.Trim());
        var contextual = builder.ToString().Trim();
        if (contextual.Length <= 8000)
        {
            return contextual;
        }

        var tail = contextual[^8000..];
        return $"[context_truncated]\n{tail}";
    }

    private async Task EnsureConversationTitleFromFirstTurnAsync(
        string conversationId,
        string preferredProvider,
        string preferredModel,
        CancellationToken cancellationToken
    )
    {
        try
        {
            var thread = _conversationStore.Get(conversationId);
            if (thread == null || !ShouldAutoTitle(thread))
            {
                return;
            }

            var isCodingScope = thread.Scope.Equals("coding", StringComparison.OrdinalIgnoreCase);
            var titleLooksFailed = IsLikelyProviderFailureText(thread.Title);
            var selectedUser = titleLooksFailed
                ? thread.Messages.LastOrDefault(x => x.Role.Equals("user", StringComparison.OrdinalIgnoreCase))?.Text?.Trim()
                : thread.Messages.FirstOrDefault(x => x.Role.Equals("user", StringComparison.OrdinalIgnoreCase))?.Text?.Trim();
            var selectedAssistant = titleLooksFailed
                ? SelectAssistantTextForAutoTitle(thread, preferLatest: true)
                : SelectAssistantTextForAutoTitle(thread, preferLatest: false);

            if (isCodingScope)
            {
                var localTitle = !string.IsNullOrWhiteSpace(selectedUser)
                    ? BuildFallbackConversationTitle(selectedUser)
                    : string.Empty;
                if (string.IsNullOrWhiteSpace(localTitle))
                {
                    localTitle = BuildFallbackConversationTitleFromAssistant(selectedAssistant);
                }

                if (!string.IsNullOrWhiteSpace(localTitle))
                {
                    _conversationStore.UpdateTitle(conversationId, localTitle);
                }

                return;
            }

            if (string.IsNullOrWhiteSpace(selectedUser))
            {
                return;
            }

            var provider = NormalizeProvider(preferredProvider, allowAuto: true);
            if (provider == "auto")
            {
                provider = await ResolveAutoProviderAsync(cancellationToken);
            }

            var title = string.Empty;
            if (provider != "none" && !string.IsNullOrWhiteSpace(selectedAssistant))
            {
                var model = ResolveModel(provider, preferredModel);
                var prompt = $"""
                            아래 대화의 제목을 한국어 한 문장으로 만들어라.
                            조건:
                            - 최대 28자
                            - 불필요한 따옴표/머리말 금지
                            - 제목만 출력

                            [사용자]
                            {selectedUser}

                            [어시스턴트]
                            {TruncateForTitle(selectedAssistant)}
                            """;
                var generated = await GenerateByProviderAsync(provider, model, prompt, cancellationToken);
                if (!IsLikelyProviderFailureText(generated.Text))
                {
                    title = NormalizeConversationTitle(generated.Text);
                }
            }

            if (string.IsNullOrWhiteSpace(title))
            {
                title = BuildFallbackConversationTitleFromAssistant(selectedAssistant);
            }

            if (string.IsNullOrWhiteSpace(title))
            {
                title = BuildFallbackConversationTitle(selectedUser);
            }

            _conversationStore.UpdateTitle(conversationId, title);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[conversation] title auto-rename failed: {ex.Message}");
        }
    }

    private async Task<MemoryNoteSaveResult?> MaybeCompressConversationAsync(
        string conversationId,
        string modeKey,
        string preferredProvider,
        string preferredModel,
        CancellationToken cancellationToken
    )
    {
        var currentChars = _conversationStore.GetTotalCharacters(conversationId);
        if (currentChars < Math.Max(2000, _config.ConversationCompressChars))
        {
            return null;
        }

        var sourceText = _conversationStore.BuildCompressionSourceText(conversationId, _config.ConversationKeepRecentMessages);
        if (string.IsNullOrWhiteSpace(sourceText))
        {
            return null;
        }

        var provider = NormalizeProvider(preferredProvider, allowAuto: true);
        if (provider == "auto")
        {
            provider = await ResolveAutoProviderAsync(cancellationToken);
            if (provider == "none")
            {
                provider = "groq";
            }
        }

        var model = ResolveModel(provider, preferredModel);
        var summaryPrompt = $"""
                            다음은 길어진 대화의 이전 구간입니다.
                            이후 대화 이어가기에 필요한 핵심 맥락만 유지해서 한국어로 압축 요약하세요.
                            반드시 포함:
                            1) 사용자 목표
                            2) 결정된 기술 선택/제약
                            3) 아직 남은 작업
                            4) 파일/경로/명령 관련 중요 사실

                            [대화 로그]
                            {sourceText}
                            """;

        var summaryResult = await GenerateByProviderAsync(provider, model, summaryPrompt, cancellationToken);
        var summary = summaryResult.Text.Trim();
        if (string.IsNullOrWhiteSpace(summary))
        {
            summary = sourceText.Length > 2400 ? sourceText[..2400] + "\n...(truncated)" : sourceText;
        }

        var thread = _conversationStore.Get(conversationId);
        if (thread == null)
        {
            return null;
        }

        var saved = _memoryNoteStore.Save(
            modeKey,
            thread.Id,
            thread.Title,
            summaryResult.Provider,
            summaryResult.Model,
            summary
        );
        _conversationStore.AddLinkedMemoryNote(conversationId, saved.Name);
        _conversationStore.CompactWithSummary(
            conversationId,
            _config.ConversationKeepRecentMessages,
            $"자동 압축 완료. 메모리 노트 `{saved.Name}` 를 컨텍스트로 사용합니다."
        );
        return saved;
    }

    private void ScheduleConversationMaintenance(
        string conversationId,
        string modeKey,
        string preferredProvider,
        string preferredModel
    )
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var titleCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await EnsureConversationTitleFromFirstTurnAsync(
                    conversationId,
                    preferredProvider,
                    preferredModel,
                    titleCts.Token
                ).ConfigureAwait(false);

                using var compressCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                _ = await MaybeCompressConversationAsync(
                    conversationId,
                    modeKey,
                    preferredProvider,
                    preferredModel,
                    compressCts.Token
                ).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[conversation] maintenance failed: {ex.Message}");
            }
        });
    }

    private string ResolveModel(string provider, string? modelOverride)
    {
        var normalizedOverride = NormalizeModelSelection(modelOverride);
        if (!string.IsNullOrWhiteSpace(normalizedOverride))
        {
            return normalizedOverride;
        }

        return provider switch
        {
            "gemini" => _config.GeminiModel,
            "cerebras" => _config.CerebrasModel,
            "copilot" => _copilotWrapper.GetSelectedModel(),
            "codex" => _config.CodexModel,
            _ => _llmRouter.GetSelectedGroqModel()
        };
    }

    private static IReadOnlyList<string> MergeMemoryNoteNames(IReadOnlyList<string> baseNames, IReadOnlyList<string>? requestNames)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in baseNames)
        {
            if (!string.IsNullOrWhiteSpace(item))
            {
                set.Add(item.Trim());
            }
        }

        if (requestNames != null)
        {
            foreach (var item in requestNames)
            {
                if (!string.IsNullOrWhiteSpace(item))
                {
                    set.Add(item.Trim());
                }
            }
        }

        return set.ToArray();
    }

    private static bool ShouldAutoTitle(ConversationThreadView thread)
    {
        var userCount = thread.Messages.Count(x => x.Role.Equals("user", StringComparison.OrdinalIgnoreCase));
        var assistantCount = thread.Messages.Count(x => x.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase));
        if (userCount < 1 || assistantCount < 1)
        {
            return false;
        }

        var title = (thread.Title ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title))
        {
            return true;
        }

        if (IsLikelyProviderFailureText(title))
        {
            return true;
        }

        if (userCount != 1)
        {
            return false;
        }

        var defaultPrefix = $"{thread.Scope}-{thread.Mode}";
        if (title.StartsWith(defaultPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (title.StartsWith("새 대화", StringComparison.OrdinalIgnoreCase)
            || title.StartsWith("new chat", StringComparison.OrdinalIgnoreCase)
            || title.StartsWith("chat-", StringComparison.OrdinalIgnoreCase)
            || title.StartsWith("coding-", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private static string NormalizeConversationTitle(string raw)
    {
        var value = (raw ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var line = value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? value;
        line = LeadingTitleNoiseRegex.Replace(line, string.Empty).Trim();
        line = line.Trim('"', '\'', '`', '“', '”', '‘', '’');
        if (line.Length > 38)
        {
            line = line[..38].TrimEnd();
        }

        return line;
    }

    private static string BuildFallbackConversationTitle(string firstUser)
    {
        var normalized = (firstUser ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "새 대화";
        }

        return normalized.Length <= 32 ? normalized : normalized[..32].TrimEnd() + "...";
    }

    private static string BuildFallbackConversationTitleFromAssistant(string assistantText)
    {
        var normalized = (assistantText ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized) || IsLikelyProviderFailureText(normalized))
        {
            return string.Empty;
        }

        normalized = Regex.Replace(normalized, @"\[(?<text>[^\]]+)\]\((?<url>https?://[^)]+)\)", "${text}");
        normalized = Regex.Replace(normalized, @"https?://\S+", string.Empty);
        normalized = normalized.Replace("**", string.Empty, StringComparison.Ordinal)
            .Replace("__", string.Empty, StringComparison.Ordinal)
            .Replace("`", string.Empty, StringComparison.Ordinal);
        normalized = Regex.Replace(normalized, @"^(요약|핵심|출처)\s*:\s*", string.Empty, RegexOptions.IgnoreCase);
        normalized = Regex.Replace(normalized, @"^(?:[-•▪*]\s+|\d+[.)]\s+)", string.Empty);
        normalized = Regex.Replace(normalized, @"\s{2,}", " ").Trim().Trim('"', '\'', '`', '“', '”', '‘', '’');
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var sentenceBoundary = normalized.IndexOfAny(new[] { '.', '!', '?', ':', ';' });
        if (sentenceBoundary > 8)
        {
            normalized = normalized[..sentenceBoundary].Trim();
        }

        return normalized.Length <= 32 ? normalized : normalized[..32].TrimEnd() + "...";
    }

    private static string TruncateForTitle(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        return normalized.Length <= 260 ? normalized : normalized[..260] + "...";
    }

    private static string SelectAssistantTextForAutoTitle(ConversationThreadView thread, bool preferLatest)
    {
        var assistantMessages = thread.Messages
            .Where(x => x.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase))
            .Select(x => (x.Text ?? string.Empty).Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToList();
        if (assistantMessages.Count == 0)
        {
            return string.Empty;
        }

        var candidatePool = preferLatest
            ? assistantMessages.AsEnumerable().Reverse()
            : assistantMessages.AsEnumerable();
        var usable = candidatePool.FirstOrDefault(x => !IsLikelyProviderFailureText(x));
        if (!string.IsNullOrWhiteSpace(usable))
        {
            return usable;
        }

        return preferLatest ? assistantMessages[^1] : assistantMessages[0];
    }

    private static bool IsLikelyProviderFailureText(string? text)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        var lowered = normalized.ToLowerInvariant();
        if (lowered.Contains("the operation was canceled", StringComparison.Ordinal)
            || lowered.Contains("the operation was cancelled", StringComparison.Ordinal))
        {
            return true;
        }

        if (lowered.EndsWith("api 키가 설정되지 않았습니다.", StringComparison.Ordinal)
            || lowered.EndsWith("인증이 필요합니다.", StringComparison.Ordinal)
            || lowered.EndsWith("응답이 비어 있습니다.", StringComparison.Ordinal)
            || lowered.EndsWith("응답이 비어 있습니다. 다시 질문해 주세요.", StringComparison.Ordinal)
            || lowered.Contains("응답 시간이 초과되었습니다.", StringComparison.Ordinal))
        {
            return true;
        }

        return lowered.StartsWith("groq 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith("gemini 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith("cerebras 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith("copilot 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith("groq 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith("gemini 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith("cerebras 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith("copilot 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith("gemini 웹검색 호출 오류:", StringComparison.Ordinal)
            || lowered.StartsWith("gemini 웹검색 요청 실패:", StringComparison.Ordinal)
            || lowered.StartsWith("gemini 웹검색 응답 시간이 초과되었습니다.", StringComparison.Ordinal)
            || lowered.StartsWith("현재 groq 요청 한도를 초과했습니다.", StringComparison.Ordinal);
    }

    private async Task<LlmSingleChatResult?> TryFallbackFromGroqRateLimitAsync(string input, CancellationToken cancellationToken)
    {
        if (IsCopilotResponseTestPrompt(input))
        {
            var model = _copilotWrapper.GetSelectedModel();
            return new LlmSingleChatResult("copilot", model, BuildMockCopilotTestResponse(model));
        }

        if (_llmRouter.HasGeminiApiKey())
        {
            var gemini = await _llmRouter.GenerateGeminiChatAsync(input, cancellationToken);
            return new LlmSingleChatResult("gemini", _config.GeminiModel, gemini);
        }

        var copilotStatus = await _copilotWrapper.GetStatusAsync(cancellationToken);
        if (copilotStatus.Installed && copilotStatus.Authenticated)
        {
            var model = _copilotWrapper.GetSelectedModel();
            var copilot = await _copilotWrapper.GenerateChatAsync(input, model, cancellationToken);
            return new LlmSingleChatResult("copilot", model, copilot);
        }

        return null;
    }

    private static bool IsGroqRateLimitResponse(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return text.Contains("429", StringComparison.Ordinal)
               || text.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
               || text.Contains("too many requests", StringComparison.OrdinalIgnoreCase)
               || text.Contains("요청 한도", StringComparison.Ordinal)
               || text.Contains("한도", StringComparison.Ordinal);
    }

    private static bool IsGroqMaxTokensResponse(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var lowered = text.ToLowerInvariant();
        return lowered.Contains("max_tokens", StringComparison.Ordinal)
               && (lowered.Contains("less than or equal", StringComparison.Ordinal)
                   || lowered.Contains("maximum value", StringComparison.Ordinal));
    }

    private static string TrimContextHistory(string history, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(history))
        {
            return string.Empty;
        }

        var lines = history
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line =>
            {
                var normalized = line.Replace("\r", " ", StringComparison.Ordinal).Trim();
                return normalized.Length <= 360 ? normalized : normalized[..360] + "...";
            })
            .ToArray();
        var combined = string.Join('\n', lines);
        if (combined.Length <= maxChars)
        {
            return combined;
        }

        return combined[^maxChars..];
    }

    private static string SanitizeChatOutput(string text, bool keepMarkdownTables = false)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return "응답이 비어 있습니다. 다시 질문해 주세요.";
        }

        var normalized = WebUtility.HtmlDecode(text ?? string.Empty);
        normalized = normalized.Replace('\u00A0', ' ');
        normalized = normalized.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\r", "\n", StringComparison.Ordinal).Trim();
        normalized = ThinkTagBlockRegex.Replace(normalized, string.Empty);
        normalized = RemoveCopilotMetaPreamble(normalized);
        var lines = normalized.Split('\n');
        var compact = new List<string>(lines.Length);
        string? previous = null;
        var repeatCount = 0;
        var inThinkBlock = false;
        var inCodeFence = false;
        var hadBlankLine = false;
        foreach (var raw in lines)
        {
            var rawLine = raw ?? string.Empty;
            if (rawLine.Contains("<think", StringComparison.OrdinalIgnoreCase))
            {
                inThinkBlock = true;
            }

            if (inThinkBlock)
            {
                if (rawLine.Contains("</think>", StringComparison.OrdinalIgnoreCase))
                {
                    inThinkBlock = false;
                }

                continue;
            }

            var line = ThinkTagInlineRegex.Replace(rawLine, string.Empty);
            var trimmedLine = line.Trim();
            if (trimmedLine.StartsWith("```", StringComparison.Ordinal))
            {
                inCodeFence = !inCodeFence;
                if (compact.Count > 0 && !string.IsNullOrWhiteSpace(compact[^1]) && hadBlankLine)
                {
                    compact.Add(string.Empty);
                }

                compact.Add(trimmedLine);
                previous = null;
                repeatCount = 0;
                hadBlankLine = false;
                continue;
            }

            if (!inCodeFence)
            {
                line = NormalizeDisplayLine(line);
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                hadBlankLine = true;
                continue;
            }

            if (ShouldDropMetaLine(line))
            {
                continue;
            }

            if (hadBlankLine && compact.Count > 0 && !string.IsNullOrWhiteSpace(compact[^1]))
            {
                compact.Add(string.Empty);
            }
            hadBlankLine = false;

            if (previous != null && line.Equals(previous, StringComparison.Ordinal))
            {
                repeatCount += 1;
                if (repeatCount >= 2)
                {
                    continue;
                }
            }
            else
            {
                previous = line;
                repeatCount = 0;
            }

            compact.Add(line);
        }

        var merged = string.Join('\n', compact);
        if (merged.Length == 0)
        {
            merged = normalized;
        }

        merged = NormalizeMarkdownTableSeparators(merged);
        merged = CollapseMarkdownTableBlankLines(merged);
        merged = UnwrapMarkdownTableCodeFences(merged);
        if (!keepMarkdownTables)
        {
            merged = ConvertMarkdownTableRowsToList(merged);
        }
        var markdownLike = IsLikelyMarkdownText(merged);
        if (!markdownLike)
        {
            merged = ImprovePlainTextLineBreaksForChat(merged);
            merged = RepeatedChunkRegex.Replace(merged, "$1 ...");
            merged = CollapseRepeatedCharacters(merged);
        }
        else
        {
            merged = Regex.Replace(merged, @"\n{3,}", "\n\n");
        }

        merged = NormalizeSourceBlockToSingleLine(merged);
        merged = NormalizeStructuredLabelBlocks(merged);
        merged = RemoveDanglingMarkdownBoldMarkers(merged);
        return merged;
    }

    private static string RemoveDanglingMarkdownBoldMarkers(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        for (var i = 0; i < lines.Length; i += 1)
        {
            var line = lines[i] ?? string.Empty;
            var trimmed = line.Trim();
            if (trimmed.Length == 0
                || trimmed.StartsWith("```", StringComparison.Ordinal)
                || IsMarkdownTableRow(trimmed))
            {
                continue;
            }

            if (Regex.Matches(line, Regex.Escape("**"), RegexOptions.CultureInvariant).Count % 2 != 0)
            {
                line = line.Replace("**", string.Empty, StringComparison.Ordinal);
            }

            if (Regex.Matches(line, Regex.Escape("__"), RegexOptions.CultureInvariant).Count % 2 != 0)
            {
                line = line.Replace("__", string.Empty, StringComparison.Ordinal);
            }

            lines[i] = line;
        }

        return string.Join('\n', lines).Trim();
    }

    private static string NormalizeSourceBlockToSingleLine(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length);

        for (var index = 0; index < lines.Length; index += 1)
        {
            var current = lines[index] ?? string.Empty;
            var currentTrimmed = current.Trim();
            if (!Regex.IsMatch(currentTrimmed, @"^(출처|sources?)\s*:?\s*$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                output.Add(current);
                continue;
            }

            var sourceNames = new List<string>(8);
            var cursor = index + 1;
            while (cursor < lines.Length)
            {
                var nextTrimmed = (lines[cursor] ?? string.Empty).Trim();
                if (nextTrimmed.Length == 0)
                {
                    // 출처 블록 내 공백 줄은 허용하되, 다음 비어있지 않은 줄이 출처 후보가 아닐 때 종료한다.
                    var lookahead = cursor + 1;
                    while (lookahead < lines.Length && string.IsNullOrWhiteSpace(lines[lookahead]))
                    {
                        lookahead += 1;
                    }

                    if (lookahead >= lines.Length || !TryExtractSourceNameCandidateLine(lines[lookahead], out _))
                    {
                        break;
                    }

                    cursor += 1;
                    continue;
                }

                if (!TryExtractSourceNameCandidateLine(lines[cursor], out var sourceName))
                {
                    break;
                }

                sourceNames.Add(sourceName);
                cursor += 1;
            }

            if (sourceNames.Count == 0)
            {
                output.Add(currentTrimmed);
                continue;
            }

            var distinctNames = sourceNames
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            output.Add($"출처: {string.Join(", ", distinctNames)}");
            index = cursor - 1;
        }

        return Regex.Replace(string.Join('\n', output).Trim(), @"\n{3,}", "\n\n");
    }

    private static string NormalizeStructuredLabelBlocks(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Trim();
        normalized = Regex.Replace(
            normalized,
            @"(?<=[.!?]|…)\s*(?=(?:[-•▪]\s*)?(?:(?:No\.\d+|\d+[.)])\s*)?[A-Za-z가-힣0-9(][A-Za-z가-힣0-9().&+_/\-·\s]{1,80}[:：](?:\s|$))",
            "\n\n",
            RegexOptions.CultureInvariant
        );
        normalized = Regex.Replace(
            normalized,
            @"(?im)^(?<head>(?:[-•▪]\s*)?(?:(?:No\.\d+|\d+[.)])\s*)?출처\s*링크\s*[:：]\s*[^\n]*?)\s+(?<url>https?://\S+)\s*$",
            "${head}\n${url}",
            RegexOptions.CultureInvariant
        );

        var lines = normalized.Split('\n', StringSplitOptions.None);
        var output = new List<string>(lines.Length + 8);
        foreach (var raw in lines)
        {
            var line = (raw ?? string.Empty).Trim();
            if (line.Length == 0)
            {
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }
                continue;
            }

            if (line.StartsWith("```", StringComparison.Ordinal) || IsMarkdownTableRow(line))
            {
                output.Add(line);
                continue;
            }

            if (TryFormatStandaloneNumberedHeadlineLine(line, out var formattedHeadline))
            {
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                output.Add(formattedHeadline);
                continue;
            }

            if (TryNormalizeExistingStructuredMarkdownLabelLine(line, out var normalizedExistingLabel))
            {
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                output.Add(normalizedExistingLabel);
                continue;
            }

            if (TryFormatStructuredMarkdownLabelLine(line, out var formatted))
            {
                if (output.Count > 0 && !string.IsNullOrWhiteSpace(output[^1]))
                {
                    output.Add(string.Empty);
                }

                output.Add(formatted);
                continue;
            }

            output.Add(line);
        }

        return Regex.Replace(string.Join('\n', output).Trim(), @"\n{3,}", "\n\n");
    }

    private static bool TryFormatStandaloneNumberedHeadlineLine(string line, out string formatted)
    {
        formatted = string.Empty;
        var normalized = (line ?? string.Empty).Trim();
        if (normalized.Length == 0 || normalized.Contains("**", StringComparison.Ordinal))
        {
            return false;
        }

        if (!TryExtractStandaloneNumberedHeadlineParts(
                normalized,
                allowWrappedBold: false,
                out var lead,
                out var body,
                out _))
        {
            return false;
        }

        formatted = lead.Length == 0
            ? $"**{body}**"
            : $"{lead}**{body}**";
        return true;
    }

    private static bool IsStandaloneNumberedHeadlineLine(string line)
    {
        return TryExtractStandaloneNumberedHeadlineParts(
            line,
            allowWrappedBold: true,
            out _,
            out _,
            out _);
    }

    private static bool TryExtractStandaloneNumberedHeadlineParts(
        string line,
        bool allowWrappedBold,
        out string lead,
        out string body,
        out string headline)
    {
        lead = string.Empty;
        body = string.Empty;
        headline = string.Empty;

        var normalized = (line ?? string.Empty).Trim();
        if (normalized.Length == 0
            || normalized.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("[", StringComparison.Ordinal)
            || normalized.StartsWith("```", StringComparison.Ordinal)
            || IsMarkdownTableRow(normalized))
        {
            return false;
        }

        var pattern = allowWrappedBold
            ? @"^(?<lead>(?:[-•▪]\s*)?)(?:\*\*(?<bodyBold>\d+[.)]\s*[^\n]+)\*\*|(?<bodyPlain>\d+[.)]\s*[^\n]+))$"
            : @"^(?<lead>(?:[-•▪]\s*)?)(?<bodyPlain>\d+[.)]\s*[^\n]+)$";
        var match = Regex.Match(normalized, pattern, RegexOptions.CultureInvariant);
        if (!match.Success)
        {
            return false;
        }

        lead = match.Groups["lead"].Value;
        body = match.Groups["bodyBold"].Success
            ? match.Groups["bodyBold"].Value.Trim()
            : match.Groups["bodyPlain"].Value.Trim();
        if (body.Length == 0)
        {
            return false;
        }

        var headlineMatch = Regex.Match(body, @"^\d+[.)]\s*(?<headline>.+)$", RegexOptions.CultureInvariant);
        if (!headlineMatch.Success)
        {
            return false;
        }

        headline = Regex.Replace(headlineMatch.Groups["headline"].Value, @"\s{2,}", " ").Trim();
        return LooksLikeStandaloneNumberedHeadlineText(headline);
    }

    private static bool LooksLikeStandaloneNumberedHeadlineText(string headline)
    {
        var normalized = (headline ?? string.Empty).Trim();
        if (normalized.Length < 2 || normalized.Length > 140)
        {
            return false;
        }

        if (normalized.Contains(':', StringComparison.Ordinal)
            || normalized.Contains('：', StringComparison.Ordinal)
            || normalized.Contains('|', StringComparison.Ordinal)
            || normalized.Contains("http://", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("https://", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (normalized.StartsWith("출처", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("요약", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("핵심", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (normalized.EndsWith(".", StringComparison.Ordinal)
            || normalized.EndsWith("?", StringComparison.Ordinal)
            || normalized.EndsWith("!", StringComparison.Ordinal)
            || normalized.EndsWith("다.", StringComparison.Ordinal)
            || normalized.EndsWith("요.", StringComparison.Ordinal)
            || normalized.EndsWith("니다.", StringComparison.Ordinal)
            || normalized.EndsWith("습니다.", StringComparison.Ordinal))
        {
            return false;
        }

        return Regex.IsMatch(normalized, @"[A-Za-z가-힣0-9]", RegexOptions.CultureInvariant);
    }

    private static bool TryNormalizeExistingStructuredMarkdownLabelLine(string line, out string formatted)
    {
        formatted = string.Empty;
        var normalized = (line ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        var match = Regex.Match(
            normalized,
            @"^(?<lead>(?:[-•▪]\s*)?(?:(?:No\.\d+|\d+[.)])\s*)?)\*\*(?<label>[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}?)\s*[:：]\*\*\s*(?<value>.*)$",
            RegexOptions.CultureInvariant
        );
        if (!match.Success)
        {
            return false;
        }

        var lead = match.Groups["lead"].Value;
        var label = Regex.Replace(match.Groups["label"].Value, @"\s{2,}", " ").Trim();
        if (!LooksLikeStructuredLabel(label))
        {
            return false;
        }

        var value = NormalizeStructuredLabelValueText(match.Groups["value"].Value);
        formatted = value.Length == 0
            ? $"{lead}**{label}:**"
            : $"{lead}**{label}:** {value}";
        return true;
    }

    private static bool TryFormatStructuredMarkdownLabelLine(string line, out string formatted)
    {
        formatted = string.Empty;
        var normalized = (line ?? string.Empty).Trim();
        if (normalized.Length == 0
            || normalized.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("[", StringComparison.Ordinal))
        {
            return false;
        }

        if (Regex.IsMatch(
                normalized,
                @"^(?:[-•▪]\s*)?(?:(?:No\.\d+|\d+[.)])\s*)?\*\*.+?:\*\*(?:\s|$)",
                RegexOptions.CultureInvariant))
        {
            return false;
        }

        var match = Regex.Match(
            normalized,
            @"^(?<lead>(?:[-•▪]\s*)?(?:(?:No\.\d+|\d+[.)])\s*)?)(?<label>[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}?)\s*[:：]\s*(?<value>.*)$",
            RegexOptions.CultureInvariant
        );
        if (!match.Success)
        {
            return false;
        }

        var lead = match.Groups["lead"].Value;
        var label = Regex.Replace(match.Groups["label"].Value, @"\s{2,}", " ").Trim();
        var value = NormalizeStructuredLabelValueText(match.Groups["value"].Value);
        if (!LooksLikeStructuredLabel(label))
        {
            return false;
        }

        formatted = value.Length == 0
            ? $"{lead}**{label}:**"
            : $"{lead}**{label}:** {value}";
        return true;
    }

    private static string NormalizeStructuredLabelValueText(string value)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        normalized = Regex.Replace(normalized, @"^\*\*\s+", string.Empty, RegexOptions.CultureInvariant);
        normalized = Regex.Replace(normalized, @"\s+\*\*$", string.Empty, RegexOptions.CultureInvariant);
        normalized = Regex.Replace(normalized, @"^\*\*$", string.Empty, RegexOptions.CultureInvariant);
        normalized = Regex.Replace(normalized, @"\s{2,}", " ").Trim();
        return normalized;
    }

    private static bool LooksLikeStructuredLabel(string label)
    {
        var normalized = (label ?? string.Empty).Trim();
        if (normalized.Length == 0 || normalized.Length > 80)
        {
            return false;
        }

        if (normalized.Contains("://", StringComparison.Ordinal)
            || normalized.Contains('[', StringComparison.Ordinal)
            || normalized.Contains(']', StringComparison.Ordinal)
            || normalized.Contains('{', StringComparison.Ordinal)
            || normalized.Contains('}', StringComparison.Ordinal))
        {
            return false;
        }

        if (Regex.IsMatch(normalized, @"^(?:오전|오후)\s*\d{1,2}$", RegexOptions.CultureInvariant))
        {
            return false;
        }

        return Regex.IsMatch(normalized, @"[A-Za-z가-힣0-9]", RegexOptions.CultureInvariant);
    }

    private static bool TryExtractSourceNameCandidateLine(string line, out string sourceName)
    {
        sourceName = string.Empty;
        var trimmed = (line ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        trimmed = Regex.Replace(trimmed, @"^[-*•]\s+", string.Empty);
        trimmed = Regex.Replace(trimmed, @"^\d+[.)]\s+", string.Empty);
        trimmed = trimmed.Trim();
        if (!IsSourceNameCandidateLine(trimmed))
        {
            return false;
        }

        sourceName = trimmed;
        return true;
    }

    private static bool IsSourceNameCandidateLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        var trimmed = line.Trim();
        if (trimmed.Length > 60)
        {
            return false;
        }

        if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (trimmed.Contains(':', StringComparison.Ordinal))
        {
            return false;
        }

        if (Regex.IsMatch(trimmed, @"^(No\.\d+|\d+[.)])\s+", RegexOptions.CultureInvariant))
        {
            return false;
        }

        if (trimmed.StartsWith("제목", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("내용", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("출처", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("요약", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (trimmed.StartsWith("[", StringComparison.Ordinal)
            || trimmed.StartsWith("{", StringComparison.Ordinal)
            || trimmed.StartsWith("```", StringComparison.Ordinal))
        {
            return false;
        }

        return true;
    }

    private static string NormalizeMarkdownTableSeparators(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        var changed = false;

        for (var i = 0; i < lines.Length; i += 1)
        {
            var line = lines[i];
            if (string.IsNullOrWhiteSpace(line) || line.IndexOf('|') < 0)
            {
                continue;
            }

            var trimmed = line.Trim();
            var candidate = trimmed;
            if (!candidate.StartsWith("|", StringComparison.Ordinal))
            {
                candidate = "|" + candidate;
            }

            if (!candidate.EndsWith("|", StringComparison.Ordinal))
            {
                candidate += "|";
            }

            if (!MarkdownTableSeparatorCandidateRegex.IsMatch(candidate))
            {
                continue;
            }

            var cellsRaw = candidate.Trim('|').Split('|', StringSplitOptions.TrimEntries);
            if (cellsRaw.Length < 2)
            {
                continue;
            }

            var cells = new List<string>(cellsRaw.Length);
            var valid = true;
            foreach (var cellRaw in cellsRaw)
            {
                var compact = Regex.Replace(cellRaw, @"\s+", string.Empty);
                compact = NormalizeDashVariants(compact);
                if (!MarkdownLooseSeparatorCellRegex.IsMatch(compact))
                {
                    valid = false;
                    break;
                }

                var leadingColon = compact.StartsWith(':');
                var trailingColon = compact.EndsWith(':');
                var dashCount = compact.Count(ch => ch == '-');
                dashCount = Math.Max(3, dashCount);

                var cell = string.Concat(
                    leadingColon ? ":" : string.Empty,
                    new string('-', dashCount),
                    trailingColon ? ":" : string.Empty
                );
                cells.Add(cell);
            }

            if (!valid)
            {
                continue;
            }

            var leadingWhitespace = line[..(line.Length - line.TrimStart().Length)];
            var rebuilt = leadingWhitespace + "| " + string.Join(" | ", cells) + " |";
            if (!line.Equals(rebuilt, StringComparison.Ordinal))
            {
                lines[i] = rebuilt;
                changed = true;
            }
        }

        return changed ? string.Join('\n', lines) : normalized;
    }

    private static string CollapseMarkdownTableBlankLines(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        if (lines.Length < 3)
        {
            return normalized;
        }

        var compact = new List<string>(lines.Length);
        for (var i = 0; i < lines.Length; i += 1)
        {
            var line = lines[i];
            if (string.IsNullOrWhiteSpace(line))
            {
                var previous = compact.Count > 0 ? compact[^1] : string.Empty;
                var next = FindNextNonEmptyLine(lines, i + 1);
                if (IsMarkdownTableRow(previous) && IsMarkdownTableRow(next))
                {
                    continue;
                }
            }

            compact.Add(line);
        }

        return string.Join('\n', compact);
    }

    private static string UnwrapMarkdownTableCodeFences(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        return Regex.Replace(
            text,
            @"```(?:markdown|md|table)?\s*\n(?<body>[\s\S]*?)```",
            match =>
            {
                var body = match.Groups["body"].Value
                    .Replace("\r\n", "\n", StringComparison.Ordinal)
                    .Replace("\r", "\n", StringComparison.Ordinal)
                    .Trim();
                if (body.Length == 0)
                {
                    return match.Value;
                }

                var lines = body
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .ToArray();
                if (lines.Length < 2)
                {
                    return match.Value;
                }

                for (var i = 0; i + 1 < lines.Length; i += 1)
                {
                    if (!IsMarkdownTableRow(lines[i]))
                    {
                        continue;
                    }

                    if (!MarkdownTableSeparatorCandidateRegex.IsMatch(lines[i + 1].Trim()))
                    {
                        continue;
                    }

                    return body;
                }

                return match.Value;
            },
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
        );
    }

    private static string ConvertMarkdownTableRowsToList(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n', StringSplitOptions.None);
        var converted = new List<string>(lines.Length);
        var inCodeFence = false;

        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                inCodeFence = !inCodeFence;
                converted.Add(line);
                continue;
            }

            if (inCodeFence)
            {
                converted.Add(line);
                continue;
            }

            if (!trimmed.StartsWith("|", StringComparison.Ordinal)
                || !trimmed.EndsWith("|", StringComparison.Ordinal))
            {
                converted.Add(line);
                continue;
            }

            if (MarkdownTableSeparatorCandidateRegex.IsMatch(trimmed))
            {
                continue;
            }

            var cells = trimmed
                .Trim('|')
                .Split('|', StringSplitOptions.TrimEntries)
                .Where(cell => !string.IsNullOrWhiteSpace(cell))
                .ToArray();
            if (cells.Length < 2)
            {
                converted.Add(line);
                continue;
            }

            converted.Add("- " + string.Join(" / ", cells));
        }

        var merged = string.Join('\n', converted).Trim();
        return Regex.Replace(merged, @"\n{3,}", "\n\n");
    }

    private static string FindNextNonEmptyLine(string[] lines, int startIndex)
    {
        for (var i = Math.Max(0, startIndex); i < lines.Length; i += 1)
        {
            if (!string.IsNullOrWhiteSpace(lines[i]))
            {
                return lines[i];
            }
        }

        return string.Empty;
    }

    private static bool IsMarkdownTableRow(string? line)
    {
        var trimmed = (line ?? string.Empty).Trim();
        if (trimmed.Length < 3)
        {
            return false;
        }

        if (!trimmed.StartsWith("|", StringComparison.Ordinal)
            || !trimmed.EndsWith("|", StringComparison.Ordinal))
        {
            return false;
        }

        return trimmed.Count(ch => ch == '|') >= 2;
    }

    private static string NormalizeDashVariants(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (ch is '\u2014' or '\u2013' or '\u2011' or '\u2212' or '\u2500' or '\u2012')
            {
                builder.Append('-');
            }
            else
            {
                builder.Append(ch);
            }
        }

        return builder.ToString();
    }

    private static string RemoveCopilotMetaPreamble(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var cleaned = WebUtility.HtmlDecode(text ?? string.Empty);
        var hasWrapperTags = cleaned.Contains("<p", StringComparison.OrdinalIgnoreCase)
            || cleaned.Contains("</p>", StringComparison.OrdinalIgnoreCase)
            || cleaned.Contains("<pre", StringComparison.OrdinalIgnoreCase)
            || cleaned.Contains("</pre>", StringComparison.OrdinalIgnoreCase)
            || cleaned.Contains("<code", StringComparison.OrdinalIgnoreCase)
            || cleaned.Contains("</code>", StringComparison.OrdinalIgnoreCase);
        if (hasWrapperTags)
        {
            cleaned = HtmlBreakTagRegex.Replace(cleaned, "\n");
            cleaned = HtmlTagRegex.Replace(cleaned, string.Empty);
        }

        cleaned = CopilotFetchParagraphRegex.Replace(cleaned, string.Empty);
        cleaned = CopilotFetchSentenceRegex.Replace(cleaned, string.Empty);
        var lines = cleaned
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizeDisplayLine)
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Where(line => !ShouldDropMetaLine(line))
            .ToArray();
        return lines.Length == 0 ? string.Empty : string.Join('\n', lines).Trim();
    }

    private static string NormalizeDisplayLine(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        var line = raw.Trim();
        line = line.Replace("<p>", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("</p>", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("<pre>", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("</pre>", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("<code>", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("</code>", string.Empty, StringComparison.OrdinalIgnoreCase);
        line = WebUtility.HtmlDecode(line);
        line = LeadingBulletSymbolRegex.Replace(line, string.Empty);
        line = Regex.Replace(line, @"[ \t]{2,}", " ").Trim();
        return line;
    }

    private static bool IsLikelyMarkdownText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        if (text.Contains("```", StringComparison.Ordinal)
            || text.Contains("| ---", StringComparison.Ordinal)
            || text.Contains("](", StringComparison.Ordinal)
            || Regex.IsMatch(text, @"\*\*.+?\*\*")
            || Regex.IsMatch(text, @"(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)", RegexOptions.Multiline))
        {
            return true;
        }

        return false;
    }

    private static string ImprovePlainTextLineBreaksForChat(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Replace("\\n", "\n", StringComparison.Ordinal)
            .Trim();

        if (!normalized.Contains('\n'))
        {
            normalized = Regex.Replace(normalized, @"(?<!\n)(\d+[.)]\s+)", "\n$1");
            normalized = Regex.Replace(normalized, @"([.!?]|…|\.{3})\s+(?=[^\n])", "$1\n");
        }

        normalized = Regex.Replace(normalized, @"\n{3,}", "\n\n");
        return normalized;
    }

    private static bool ShouldDropMetaLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return true;
        }

        var trimmed = line.Trim();
        if (trimmed.Equals("copy", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("복사", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("", StringComparison.Ordinal)
            || trimmed.Equals("", StringComparison.Ordinal))
        {
            return true;
        }

        if (CopilotMetaLineRegex.IsMatch(line))
        {
            return true;
        }

        if (line.StartsWith("현재 작업:", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (line.StartsWith("[자동 전환 모델:", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private static string CollapseRepeatedCharacters(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(text.Length);
        var prev = '\0';
        var count = 0;
        foreach (var ch in text)
        {
            if (ch == prev)
            {
                count += 1;
            }
            else
            {
                prev = ch;
                count = 1;
            }

            if (count <= 8)
            {
                builder.Append(ch);
            }
            else if (count == 9)
            {
                builder.Append("...");
            }
        }

        return builder.ToString();
    }

    private static string CollapseRepeatedSentenceRuns(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var segments = Regex.Split(text, @"(?<=[\.\!\?]|다\.)\s+")
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToArray();
        if (segments.Length <= 1)
        {
            return text;
        }

        var builder = new StringBuilder(text.Length);
        string? prev = null;
        var repeats = 0;
        foreach (var segment in segments)
        {
            var normalized = Regex.Replace(segment, @"\s+", " ").Trim();
            if (prev != null && string.Equals(prev, normalized, StringComparison.OrdinalIgnoreCase))
            {
                repeats += 1;
                if (repeats >= 2)
                {
                    continue;
                }
            }
            else
            {
                prev = normalized;
                repeats = 0;
            }

            if (builder.Length > 0)
            {
                builder.Append(' ');
            }

            builder.Append(normalized);
        }

        return builder.Length == 0 ? text : builder.ToString();
    }

    private static string BuildMultiAssistantText(LlmMultiChatResult result)
    {
        var blocks = new List<string>
        {
            $"[Groq]\n{result.GroqText}",
            $"[Gemini]\n{result.GeminiText}",
            $"[Cerebras]\n{result.CerebrasText}",
            $"[Copilot]\n{result.CopilotText}"
        };
        if (!string.IsNullOrWhiteSpace(result.CodexText))
        {
            blocks.Add($"[Codex]\n{result.CodexText}");
        }

        blocks.Add($"[공통 요약]\n{result.Summary}");
        return string.Join("\n\n", blocks);
    }

    private static string BuildCodeGenerationPrompt(string input, string languageHint, string modeLabel)
    {
        return $"""
                너는 로컬 실행 가능한 코드를 생성하는 엔지니어다.
                모드: {modeLabel}
                언어 힌트: {languageHint}

                아래 형식을 반드시 지켜라:
                1) 첫 줄에 LANGUAGE=<실행언어> (예: python, javascript, c, cpp, csharp, java, kotlin, html, css, bash)
                2) 다음에 단 하나의 코드블록만 출력
                3) 코드블록 안에는 순수 코드만 포함 (설명 금지)

                요청:
                {input}
                """;
    }

    private static ParsedCode ParseCodeCandidate(string text, string languageHint)
    {
        var raw = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new ParsedCode(NormalizeLanguageForCode(languageHint), string.Empty);
        }

        var firstLine = raw.Split('\n').FirstOrDefault() ?? string.Empty;
        var explicitLanguage = string.Empty;
        if (firstLine.StartsWith("LANGUAGE=", StringComparison.OrdinalIgnoreCase))
        {
            explicitLanguage = firstLine["LANGUAGE=".Length..].Trim();
        }

        var detectedLanguage = NormalizeLanguageForCode(string.IsNullOrWhiteSpace(explicitLanguage) ? languageHint : explicitLanguage);
        var match = CodeFenceRegex.Match(raw);
        if (match.Success)
        {
            var fenceLanguage = match.Groups[1].Value.Trim();
            var fenceCode = match.Groups[2].Value;
            if (!string.IsNullOrWhiteSpace(fenceLanguage))
            {
                detectedLanguage = NormalizeLanguageForCode(fenceLanguage);
            }

            return new ParsedCode(detectedLanguage, fenceCode.Trim());
        }

        var jsonMatch = JsonObjectRegex.Match(raw);
        if (jsonMatch.Success)
        {
            var jsonCode = jsonMatch.Value.Trim();
            return new ParsedCode(detectedLanguage, jsonCode);
        }

        var cleaned = raw
            .Replace("LANGUAGE=", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Trim();
        return new ParsedCode(detectedLanguage, cleaned);
    }

    private async Task<CodingWorkerResult> RunCodingWorkerAsync(
        string provider,
        string model,
        string prompt,
        string languageHint,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null,
        string progressMode = "worker",
        bool allowRunActions = true
    )
    {
        if (!allowRunActions)
        {
            return await RunDraftCodingWorkerAsync(
                provider,
                model,
                prompt,
                languageHint,
                cancellationToken
            );
        }

        var outcome = await RunAutonomousCodingLoopAsync(
            provider,
            model,
            prompt,
            languageHint,
            "worker",
            cancellationToken,
            progressCallback,
            progressMode,
            allowRunActions
        );
        return new CodingWorkerResult(
            provider,
            model,
            outcome.Language,
            outcome.Code,
            outcome.RawResponse + "\n\n[loop]\n" + outcome.Summary,
            outcome.Execution,
            outcome.ChangedFiles
        );
    }

    private async Task<CodingWorkerResult> RunDraftCodingWorkerAsync(
        string provider,
        string model,
        string objective,
        string languageHint,
        CancellationToken cancellationToken
    )
    {
        var draftPrompt = BuildDraftCodingWorkerPrompt(objective, languageHint);
        var generated = await GenerateByProviderSafeAsync(
            provider,
            model,
            draftPrompt,
            cancellationToken,
            Math.Min(Math.Max(1400, _config.CodingMaxOutputTokens), 3200),
            useRawCodexPrompt: true
        );

        var rawResponse = (generated.Text ?? string.Empty).Trim();
        var parsed = ExtractFallbackCode(rawResponse, languageHint, objective);
        if (string.IsNullOrWhiteSpace(parsed.Code))
        {
            var codeOnlyPrompt = BuildFallbackCodeOnlyPrompt(objective, languageHint);
            var fallback = await GenerateByProviderSafeAsync(
                provider,
                model,
                codeOnlyPrompt,
                cancellationToken,
                Math.Min(Math.Max(1400, _config.CodingMaxOutputTokens), 3200),
                useRawCodexPrompt: true
            );
            var fallbackRaw = (fallback.Text ?? string.Empty).Trim();
            var fallbackParsed = ExtractFallbackCode(fallbackRaw, languageHint, objective);
            if (!string.IsNullOrWhiteSpace(fallbackParsed.Code))
            {
                parsed = fallbackParsed;
                rawResponse = string.IsNullOrWhiteSpace(rawResponse) ? fallbackRaw : $"{rawResponse}\n\n[code-only-fallback]\n{fallbackRaw}";
            }
        }

        var resolvedLanguage = string.IsNullOrWhiteSpace(parsed.Language)
            ? ResolveInitialCodingLanguage(languageHint, objective)
            : NormalizeLanguageForCode(parsed.Language);
        var execution = new CodeExecutionResult(
            resolvedLanguage,
            "-",
            "-",
            "(draft-only)",
            0,
            string.Empty,
            string.Empty,
            "skipped"
        );

        return new CodingWorkerResult(
            provider,
            model,
            resolvedLanguage,
            parsed.Code,
            string.IsNullOrWhiteSpace(rawResponse) ? "초안 생성 결과가 비어 있습니다." : rawResponse,
            execution,
            Array.Empty<string>()
        );
    }

    private async Task<AutonomousCodingOutcome> RunAutonomousCodingLoopAsync(
        string provider,
        string model,
        string objective,
        string languageHint,
        string modeLabel,
        CancellationToken cancellationToken,
        Action<CodingProgressUpdate>? progressCallback = null,
        string? progressModeOverride = null,
        bool allowRunActions = true
    )
    {
        var workspaceRoot = ResolveWorkspaceRoot();
        var oneShotMode = ShouldUseOneShotMode(provider, objective, languageHint);
        var maxIterations = ResolveMaxIterations(provider, oneShotMode);
        var maxActions = ResolveMaxActions(provider, oneShotMode);
        var iterations = new List<string>();
        var progressMode = string.IsNullOrWhiteSpace(progressModeOverride) ? modeLabel : progressModeOverride;

        var currentLanguage = ResolveInitialCodingLanguage(languageHint, objective);
        var lastCode = string.Empty;
        var lastWritePath = "-";
        var lastRawResponse = string.Empty;
        var changedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var deferredRunCommand = string.Empty;
        var hasDeferredRunAction = false;
        var consecutivePlanParseFailures = 0;
        var consecutiveNoActionPlans = 0;
        var lastExecution = new CodeExecutionResult(
            currentLanguage,
            workspaceRoot,
            "-",
            "(none)",
            0,
            "아직 실행 명령이 없습니다.",
            string.Empty,
            "skipped"
        );

        progressCallback?.Invoke(BuildCodingProgressUpdate(
            progressMode,
            provider,
            model,
            "start",
            "요청을 해석하고 작업 범위를 정리합니다.",
            0,
            maxIterations,
            3,
            false,
            "request",
            "요청 분석",
            BuildCodingObjectiveProgressDetail(objective, languageHint),
            1,
            VisibleCodingStageTotal
        ));

        var initialSnapshot = BuildWorkspaceSnapshot(workspaceRoot, provider);
        progressCallback?.Invoke(BuildCodingProgressUpdate(
            progressMode,
            provider,
            model,
            "scanning",
            "현재 작업공간 상태를 확인합니다.",
            0,
            maxIterations,
            10,
            false,
            "workspace",
            "작업공간 점검",
            BuildWorkspaceProgressDetail(initialSnapshot),
            2,
            VisibleCodingStageTotal
        ));

        for (var i = 1; i <= maxIterations; i++)
        {
            var snapshot = i == 1 ? initialSnapshot : BuildWorkspaceSnapshot(workspaceRoot, provider);
            var recent = BuildRecentLoopLogs(iterations, provider);
            var loopPrompt = BuildCodingLoopPrompt(
                objective,
                languageHint,
                modeLabel,
                workspaceRoot,
                provider,
                oneShotMode,
                i,
                maxIterations,
                snapshot,
                recent,
                lastExecution
            );

            var generated = await GenerateByProviderSafeAsync(
                provider,
                model,
                loopPrompt,
                cancellationToken,
                GetCodingPlanMaxOutputTokens(provider),
                useRawCodexPrompt: true
            );
            lastRawResponse = generated.Text;
            var plan = ParseCodingLoopPlan(generated.Text);
            if (plan == null)
            {
                consecutivePlanParseFailures++;
                consecutiveNoActionPlans = 0;
                iterations.Add($"iter={i} plan_parse_failed");
                progressCallback?.Invoke(BuildCodingProgressUpdate(
                    progressMode,
                    provider,
                    model,
                    "retry",
                    $"반복 {i}/{maxIterations}: 계획 파싱 실패로 다음 반복에서 복구합니다.",
                    i,
                    maxIterations,
                    Math.Clamp((int)Math.Round((double)i / maxIterations * 55d), 18, 54),
                    false,
                    "planning",
                    "구현 계획",
                    "응답 형식을 다시 정렬한 뒤 계획을 재생성합니다.",
                    3,
                    VisibleCodingStageTotal
                ));
                if (consecutivePlanParseFailures >= 2)
                {
                    iterations.Add($"iter={i} plan_parse_abort");
                    break;
                }

                continue;
            }

            consecutivePlanParseFailures = 0;
            var actionResults = new List<string>();
            var actions = plan.Actions.Take(maxActions).ToArray();
            progressCallback?.Invoke(BuildCodingProgressUpdate(
                progressMode,
                provider,
                model,
                "planning",
                $"반복 {i}/{maxIterations}: 이번 구현 계획을 정리했습니다.",
                i,
                maxIterations,
                Math.Clamp((int)Math.Round((double)i / maxIterations * 45d), 16, 48),
                false,
                "planning",
                "구현 계획",
                BuildCodingPlanProgressDetail(plan, actions, actions.Any(action => string.Equals(action.Type, "run", StringComparison.OrdinalIgnoreCase))),
                3,
                VisibleCodingStageTotal
            ));
            if (actions.Length == 0)
            {
                consecutiveNoActionPlans++;
                actionResults.Add("actions=none");
                iterations.Add($"iter={i} analysis={TrimForOutput(plan.Analysis ?? string.Empty)} | {string.Join(" ; ", actionResults)}");
                progressCallback?.Invoke(BuildCodingProgressUpdate(
                    progressMode,
                    provider,
                    model,
                    "idle",
                    $"반복 {i}/{maxIterations}: 이번 반복에는 실행할 액션이 없습니다.",
                    i,
                    maxIterations,
                    Math.Clamp((int)Math.Round((double)i / maxIterations * 58d), 20, 60),
                    false,
                    "planning",
                    "구현 계획",
                    "생성된 계획에 실질 액션이 없어 다음 반복으로 넘어갑니다.",
                    3,
                    VisibleCodingStageTotal
                ));
                if (plan.Done)
                {
                    break;
                }

                if (consecutiveNoActionPlans >= 2)
                {
                    iterations.Add($"iter={i} actions_none_abort");
                    break;
                }

                continue;
            }

            consecutiveNoActionPlans = 0;
            var iterationChangedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var action in actions)
            {
                if (string.Equals(action.Type, "run", StringComparison.OrdinalIgnoreCase))
                {
                    var candidateCommand = (action.Command ?? string.Empty).Trim();
                    if (!string.IsNullOrWhiteSpace(candidateCommand))
                    {
                        deferredRunCommand = candidateCommand;
                        hasDeferredRunAction = true;
                        actionResults.Add($"run_deferred:{TrimForOutput(candidateCommand, 120)}");
                    }
                    else
                    {
                        actionResults.Add("run_deferred:empty_command");
                    }

                    continue;
                }

                var exec = await ExecuteCodingLoopActionAsync(action, workspaceRoot, cancellationToken);
                actionResults.Add(exec.Message);
                if (exec.Execution != null)
                {
                    lastExecution = exec.Execution;
                }

                if (!string.IsNullOrWhiteSpace(exec.LastWrittenFile))
                {
                    lastWritePath = exec.LastWrittenFile;
                }

                if (!string.IsNullOrWhiteSpace(exec.CodePreview))
                {
                    lastCode = exec.CodePreview;
                    currentLanguage = GuessLanguageFromPath(exec.LastWrittenFile, currentLanguage);
                }

                if (exec.Changed && !string.IsNullOrWhiteSpace(exec.ChangedPath))
                {
                    changedFiles.Add(exec.ChangedPath);
                    iterationChangedPaths.Add(exec.ChangedPath);
                }
            }

            iterations.Add($"iter={i} analysis={TrimForOutput(plan.Analysis ?? string.Empty)} | {string.Join(" ; ", actionResults)}");
            progressCallback?.Invoke(BuildCodingProgressUpdate(
                progressMode,
                provider,
                model,
                "writing",
                $"반복 {i}/{maxIterations}: 파일 생성/수정을 진행했습니다.",
                i,
                maxIterations,
                Math.Clamp((int)Math.Round((double)i / maxIterations * 78d), 28, 82),
                false,
                "writing",
                "파일 생성 및 수정",
                BuildCodingWriteProgressDetail(iterationChangedPaths, hasDeferredRunAction),
                4,
                VisibleCodingStageTotal
            ));
            if (plan.Done && (lastExecution.Status == "ok" || lastExecution.Status == "skipped"))
            {
                break;
            }
        }

        if (changedFiles.Count == 0)
        {
            progressCallback?.Invoke(BuildCodingProgressUpdate(
                progressMode,
                provider,
                model,
                "fallback",
                "변경 파일이 없어 복구 생성 경로를 시도합니다.",
                maxIterations,
                maxIterations,
                86,
                false,
                "recovery",
                "마무리 및 복구",
                "플랜 결과가 비어 있어 코드 블록 기반 복구 생성을 시도합니다.",
                5,
                VisibleCodingStageTotal
            ));

            var fallbackPrompt = BuildFallbackCodeOnlyPrompt(objective, currentLanguage);
            var fallbackGenerated = await GenerateByProviderSafeAsync(
                provider,
                model,
                fallbackPrompt,
                cancellationToken,
                Math.Min(_config.CodingMaxOutputTokens, 4096),
                useRawCodexPrompt: true
            );
            lastRawResponse = fallbackGenerated.Text;
            var fallbackCode = ExtractFallbackCode(fallbackGenerated.Text, currentLanguage, objective);
            if (!string.IsNullOrWhiteSpace(fallbackCode.Code))
            {
                var fallbackPath = SuggestFallbackEntryPath(fallbackCode.Language, objective);
                var writeAction = new CodingLoopAction("write_file", fallbackPath, fallbackCode.Code, string.Empty);
                var writeResult = await ExecuteCodingLoopActionAsync(writeAction, workspaceRoot, cancellationToken);
                iterations.Add($"fallback=write:{writeResult.LastWrittenFile}");

                if (!string.IsNullOrWhiteSpace(writeResult.LastWrittenFile))
                {
                    lastWritePath = writeResult.LastWrittenFile;
                }

                if (!string.IsNullOrWhiteSpace(writeResult.CodePreview))
                {
                    lastCode = writeResult.CodePreview;
                }

                currentLanguage = fallbackCode.Language;
                if (writeResult.Changed && !string.IsNullOrWhiteSpace(writeResult.ChangedPath))
                {
                    changedFiles.Add(writeResult.ChangedPath);
                }
            }
            else
            {
                iterations.Add("fallback=no_code");
            }
        }

        if (changedFiles.Count == 0 && TryGenerateDeterministicUiCloneScaffold(objective, workspaceRoot, out var scaffoldFiles))
        {
            foreach (var scaffold in scaffoldFiles)
            {
                var writeAction = new CodingLoopAction("write_file", scaffold.Path, scaffold.Content, string.Empty);
                var writeResult = await ExecuteCodingLoopActionAsync(writeAction, workspaceRoot, cancellationToken);
                if (writeResult.Changed && !string.IsNullOrWhiteSpace(writeResult.ChangedPath))
                {
                    changedFiles.Add(writeResult.ChangedPath);
                    lastWritePath = writeResult.LastWrittenFile;
                    lastCode = writeResult.CodePreview;
                }
            }

            iterations.Add($"fallback=scaffold:{string.Join(",", scaffoldFiles.Select(x => x.Path))}");
            currentLanguage = "html";
        }

        if (changedFiles.Count > 0)
        {
            progressCallback?.Invoke(BuildCodingProgressUpdate(
                progressMode,
                provider,
                model,
                "finalizing",
                "최종 실행 전에 변경 사항을 정리합니다.",
                maxIterations,
                maxIterations,
                92,
                false,
                "recovery",
                "마무리 및 복구",
                $"{changedFiles.Count}개 파일 변경을 기준으로 마지막 검증 명령을 준비합니다.",
                5,
                VisibleCodingStageTotal
            ));
        }

        if (allowRunActions)
        {
            var finalCommand = string.IsNullOrWhiteSpace(deferredRunCommand)
                ? BuildVerificationCommand(currentLanguage, changedFiles, workspaceRoot)
                : deferredRunCommand;
            if (!string.IsNullOrWhiteSpace(finalCommand))
            {
                progressCallback?.Invoke(BuildCodingProgressUpdate(
                    progressMode,
                    provider,
                    model,
                    "verifying",
                    "최종 실행 및 검증을 1회 수행합니다.",
                    maxIterations,
                    maxIterations,
                    97,
                    false,
                    "verification",
                    "최종 실행 및 검증",
                    $"실행 명령: {TrimForOutput(finalCommand, 180)}",
                    6,
                    VisibleCodingStageTotal
                ));
                var shell = await RunWorkspaceCommandWithAutoInstallAsync(finalCommand, workspaceRoot, cancellationToken);
                lastExecution = new CodeExecutionResult(
                    "bash",
                    workspaceRoot,
                    "-",
                    finalCommand,
                    shell.ExitCode,
                    shell.StdOut,
                    shell.StdErr,
                    shell.TimedOut ? "timeout" : (shell.ExitCode == 0 ? "ok" : "error")
                );
            }
        }

        if (File.Exists(lastWritePath))
        {
            try
            {
                lastCode = await File.ReadAllTextAsync(lastWritePath, cancellationToken);
            }
            catch
            {
            }
        }

        var orderedChangedFiles = changedFiles
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var summary = BuildAutonomousCodingSummary(iterations, orderedChangedFiles, lastExecution, maxIterations);
        progressCallback?.Invoke(BuildCodingProgressUpdate(
            progressMode,
            provider,
            model,
            "done",
            "코딩 작업이 완료되었습니다.",
            maxIterations,
            maxIterations,
            100,
            true,
            "verification",
            "최종 실행 및 검증",
            $"최종 상태: {lastExecution.Status} (exit={lastExecution.ExitCode})",
            6,
            VisibleCodingStageTotal
        ));
        return new AutonomousCodingOutcome(currentLanguage, lastCode, lastRawResponse, lastExecution, orderedChangedFiles, summary);
    }

    private async Task<CodingLoopActionResult> ExecuteCodingLoopActionAsync(
        CodingLoopAction action,
        string workspaceRoot,
        CancellationToken cancellationToken
    )
    {
        var type = NormalizeCodingActionType(action.Type, action.Path, action.Content, action.Command);
        var resolvedPath = ResolveActionPathOrFallback(type, action.Path, action.Content);
        if (type != "run" && string.IsNullOrWhiteSpace(resolvedPath))
        {
            return new CodingLoopActionResult($"{type}:missing_path", null, string.Empty, string.Empty, string.Empty, false);
        }

        if (type == "mkdir")
        {
            var dir = ResolveWorkspacePath(workspaceRoot, resolvedPath);
            Directory.CreateDirectory(dir);
            return new CodingLoopActionResult($"mkdir:{dir}", null, string.Empty, dir, dir, false);
        }

        if (type == "write_file")
        {
            var filePath = ResolveWorkspacePath(workspaceRoot, resolvedPath);
            var parent = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            await File.WriteAllTextAsync(filePath, action.Content ?? string.Empty, cancellationToken);
            var preview = (action.Content ?? string.Empty);
            if (preview.Length > 12000)
            {
                preview = preview[..12000] + "\n...(truncated)";
            }

            return new CodingLoopActionResult($"write:{filePath}", null, preview, filePath, filePath, true);
        }

        if (type == "append_file")
        {
            var filePath = ResolveWorkspacePath(workspaceRoot, resolvedPath);
            var parent = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            await File.AppendAllTextAsync(filePath, action.Content ?? string.Empty, cancellationToken);
            string preview;
            try
            {
                var current = await File.ReadAllTextAsync(filePath, cancellationToken);
                preview = current.Length <= 12000 ? current : current[^12000..];
            }
            catch
            {
                preview = action.Content ?? string.Empty;
            }

            return new CodingLoopActionResult($"append:{filePath}", null, preview, filePath, filePath, true);
        }

        if (type == "read_file")
        {
            var filePath = ResolveWorkspacePath(workspaceRoot, resolvedPath);
            if (!File.Exists(filePath))
            {
                return new CodingLoopActionResult($"read_miss:{filePath}", null, string.Empty, filePath, filePath, false);
            }

            var content = await File.ReadAllTextAsync(filePath, cancellationToken);
            var preview = content.Length <= 8000 ? content : content[..8000] + "\n...(truncated)";
            return new CodingLoopActionResult($"read:{filePath}", null, preview, filePath, filePath, false);
        }

        if (type == "delete_file")
        {
            var filePath = ResolveWorkspacePath(workspaceRoot, resolvedPath);
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                return new CodingLoopActionResult($"delete:{filePath}", null, string.Empty, filePath, filePath, true);
            }

            return new CodingLoopActionResult($"delete_miss:{filePath}", null, string.Empty, filePath, filePath, false);
        }

        if (type == "run")
        {
            var command = (action.Command ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(command))
            {
                return new CodingLoopActionResult("run:empty_command", null, string.Empty, string.Empty, string.Empty, false);
            }

            var shell = await RunWorkspaceCommandWithAutoInstallAsync(command, workspaceRoot, cancellationToken);
            var execution = new CodeExecutionResult(
                "bash",
                workspaceRoot,
                "-",
                command,
                shell.ExitCode,
                shell.StdOut,
                shell.StdErr,
                shell.TimedOut ? "timeout" : (shell.ExitCode == 0 ? "ok" : "error")
            );
            return new CodingLoopActionResult($"run:{command} => {execution.Status}", execution, string.Empty, string.Empty, string.Empty, false);
        }

        return new CodingLoopActionResult($"unsupported_action:{type}", null, string.Empty, string.Empty, string.Empty, false);
    }

    private static CodingLoopPlan? ParseCodingLoopPlan(string rawText)
    {
        var text = (rawText ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var variants = BuildCodingPlanTextVariants(text);
        var candidates = new List<string>();
        foreach (var variant in variants)
        {
            if (variant.StartsWith("{", StringComparison.Ordinal))
            {
                candidates.Add(variant);
            }

            var firstBrace = variant.IndexOf('{');
            var lastBrace = variant.LastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace)
            {
                candidates.Add(variant[firstBrace..(lastBrace + 1)]);
            }

            var codeFence = CodeFenceRegex.Match(variant);
            if (codeFence.Success)
            {
                candidates.Add(codeFence.Groups[2].Value.Trim());
            }
        }

        foreach (var candidate in candidates.Distinct())
        {
            try
            {
                using var doc = JsonDocument.Parse(NormalizeJsonCandidate(candidate));
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var analysis = GetStringProperty(doc.RootElement, "analysis");
                var finalMessage = GetStringProperty(doc.RootElement, "final_message");
                var done = GetBoolProperty(doc.RootElement, "done");
                var actions = new List<CodingLoopAction>();
                if (doc.RootElement.TryGetProperty("actions", out var actionsElement)
                    && actionsElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var actionElement in actionsElement.EnumerateArray())
                    {
                        if (actionElement.ValueKind != JsonValueKind.Object)
                        {
                            continue;
                        }

                        var type = GetStringProperty(actionElement, "type");
                        if (string.IsNullOrWhiteSpace(type))
                        {
                            type = GetStringProperty(actionElement, "op");
                        }

                        var path = GetStringProperty(actionElement, "path") ?? string.Empty;
                        var content = GetStringProperty(actionElement, "content") ?? string.Empty;
                        var command = GetStringProperty(actionElement, "command") ?? string.Empty;
                        actions.Add(new CodingLoopAction(
                            NormalizeCodingActionType(type, path, content, command),
                            path,
                            content,
                            command
                        ));
                    }
                }

                return new CodingLoopPlan(analysis ?? string.Empty, finalMessage ?? string.Empty, done, actions);
            }
            catch
            {
            }
        }

        return null;
    }

    private static IReadOnlyList<string> BuildCodingPlanTextVariants(string text)
    {
        var list = new List<string>();
        AddVariant(list, text);

        var decoded = WebUtility.HtmlDecode(text);
        AddVariant(list, decoded);
        AddVariant(list, UnwrapHtmlContainer(decoded));

        var unwrapped = UnwrapHtmlContainer(text);
        AddVariant(list, unwrapped);
        AddVariant(list, WebUtility.HtmlDecode(unwrapped));

        return list.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static void AddVariant(List<string> variants, string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(trimmed))
        {
            variants.Add(trimmed);
        }
    }

    private static string UnwrapHtmlContainer(string text)
    {
        var current = (text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(current))
        {
            return string.Empty;
        }

        current = current.TrimStart('●', '•', '-', '*', ' ');
        for (var i = 0; i < 3; i++)
        {
            var match = OuterHtmlContainerRegex.Match(current);
            if (!match.Success)
            {
                break;
            }

            current = match.Groups[2].Value.Trim();
        }

        return current;
    }

    private static string NormalizeJsonCandidate(string candidate)
    {
        var normalized = (candidate ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return normalized;
        }

        normalized = WebUtility.HtmlDecode(normalized);
        normalized = UnwrapHtmlContainer(normalized);
        normalized = normalized
            .Replace('\u201c', '"')
            .Replace('\u201d', '"')
            .Replace('\u2018', '\'')
            .Replace('\u2019', '\'');
        normalized = EscapeJsonControlCharsInsideStrings(normalized);
        normalized = JsonTrailingCommaRegex.Replace(normalized, "$1");

        return normalized.Trim();
    }

    private static string EscapeJsonControlCharsInsideStrings(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return input ?? string.Empty;
        }

        var builder = new StringBuilder(input.Length + 64);
        var inString = false;
        var escaped = false;

        for (var i = 0; i < input.Length; i++)
        {
            var ch = input[i];
            if (!inString)
            {
                if (ch == '"')
                {
                    inString = true;
                }

                builder.Append(ch);
                continue;
            }

            if (escaped)
            {
                builder.Append(ch);
                escaped = false;
                continue;
            }

            if (ch == '\\')
            {
                builder.Append(ch);
                escaped = true;
                continue;
            }

            if (ch == '"')
            {
                builder.Append(ch);
                inString = false;
                continue;
            }

            if (ch == '\r')
            {
                builder.Append("\\n");
                if (i + 1 < input.Length && input[i + 1] == '\n')
                {
                    i++;
                }
                continue;
            }

            if (ch == '\n')
            {
                builder.Append("\\n");
                continue;
            }

            if (ch == '\t')
            {
                builder.Append("\\t");
                continue;
            }

            builder.Append(ch);
        }

        return builder.ToString();
    }

    private static string BuildFallbackCodeOnlyPrompt(string objective, string languageHint)
    {
        return $"""
                아래 요구사항을 만족하는 실행 가능한 코드만 반환하세요.
                규칙:
                - 반드시 첫 줄: LANGUAGE=<언어>
                - 반드시 단 하나의 코드블록만 출력
                - 설명/해설/JSON/HTML 태그 금지
                - 코드블록 안에는 순수 코드만 작성

                언어 힌트: {languageHint}
                요구사항:
                {objective}
                """;
    }

    private static ParsedCode ExtractFallbackCode(string rawText, string languageHint, string objective)
    {
        var initialLanguage = ResolveInitialCodingLanguage(languageHint, objective);
        var variants = BuildCodingPlanTextVariants(rawText ?? string.Empty);
        foreach (var variant in variants)
        {
            var matches = CodeFenceRegex.Matches(variant);
            if (matches.Count == 0)
            {
                continue;
            }

            var fence = matches[^1];
            var code = fence.Groups[2].Value.Trim();
            if (string.IsNullOrWhiteSpace(code))
            {
                continue;
            }

            var fenceLanguage = fence.Groups[1].Value.Trim();
            var resolved = string.IsNullOrWhiteSpace(fenceLanguage)
                ? initialLanguage
                : NormalizeLanguageForCode(fenceLanguage);
            return new ParsedCode(resolved, code);
        }

        foreach (var variant in variants)
        {
            var prefixed = ExtractLanguagePrefixedPlainCode(variant, initialLanguage);
            if (!string.IsNullOrWhiteSpace(prefixed.Code))
            {
                return prefixed;
            }
        }

        var plain = (rawText ?? string.Empty).Trim();
        if (plain.StartsWith("<!doctype html", StringComparison.OrdinalIgnoreCase)
            || plain.StartsWith("<html", StringComparison.OrdinalIgnoreCase))
        {
            return new ParsedCode("html", plain);
        }

        var decoded = WebUtility.HtmlDecode(rawText ?? string.Empty);
        var contentMatches = JsonContentFieldRegex.Matches(decoded)
            .Select(match => new
            {
                Value = Regex.Unescape(match.Groups[1].Value).Trim(),
                Index = match.Index
            })
            .Where(x => !string.IsNullOrWhiteSpace(x.Value))
            .OrderByDescending(x => x.Value.Length)
            .ToArray();
        if (contentMatches.Length > 0)
        {
            var extractedContent = contentMatches[0].Value;
            var detectedLanguage = initialLanguage;
            var pathMatches = JsonPathFieldRegex.Matches(decoded)
                .Select(match => new
                {
                    Value = Regex.Unescape(match.Groups[1].Value).Trim(),
                    Index = match.Index
                })
                .Where(x => !string.IsNullOrWhiteSpace(x.Value))
                .ToArray();
            if (pathMatches.Length > 0)
            {
                var closestPath = pathMatches
                    .OrderBy(path => Math.Abs(path.Index - contentMatches[0].Index))
                    .First();
                detectedLanguage = GuessLanguageFromPath(closestPath.Value, detectedLanguage);
            }

            return new ParsedCode(detectedLanguage, extractedContent);
        }

        return new ParsedCode(initialLanguage, string.Empty);
    }

    private static ParsedCode ExtractLanguagePrefixedPlainCode(string text, string fallbackLanguage)
    {
        var normalized = WebUtility.HtmlDecode(text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return new ParsedCode(NormalizeLanguageForCode(fallbackLanguage), string.Empty);
        }

        var lines = normalized.Split('\n');
        if (lines.Length == 0)
        {
            return new ParsedCode(NormalizeLanguageForCode(fallbackLanguage), string.Empty);
        }

        var firstLine = lines[0].Trim();
        if (!firstLine.StartsWith("LANGUAGE=", StringComparison.OrdinalIgnoreCase))
        {
            return new ParsedCode(NormalizeLanguageForCode(fallbackLanguage), string.Empty);
        }

        var declaredLanguage = firstLine["LANGUAGE=".Length..].Trim();
        var resolvedLanguage = NormalizeLanguageForCode(
            string.IsNullOrWhiteSpace(declaredLanguage) ? fallbackLanguage : declaredLanguage
        );

        if (lines.Length <= 1)
        {
            return new ParsedCode(resolvedLanguage, string.Empty);
        }

        var code = string.Join('\n', lines.Skip(1))
            .Trim('\n', '\r')
            .TrimEnd();

        if (code.StartsWith("```", StringComparison.Ordinal))
        {
            var fence = CodeFenceRegex.Match(code);
            if (fence.Success)
            {
                var fencedCode = fence.Groups[2].Value.Trim();
                if (!string.IsNullOrWhiteSpace(fencedCode))
                {
                    return new ParsedCode(resolvedLanguage, fencedCode);
                }
            }
        }

        return new ParsedCode(resolvedLanguage, code);
    }

    private static string SuggestFallbackEntryPath(string language, string objective)
    {
        var normalizedLanguage = NormalizeLanguageForCode(language);
        var objectiveText = (objective ?? string.Empty).ToLowerInvariant();
        var domainMatch = DomainRegex.Match(objectiveText);
        var projectFolder = domainMatch.Success
            ? SanitizePathSegment(domainMatch.Groups[1].Value)
            : objectiveText.Contains("naver", StringComparison.OrdinalIgnoreCase)
                ? "naver.com"
                : objectiveText.Contains("clone", StringComparison.OrdinalIgnoreCase) || objectiveText.Contains("클론", StringComparison.OrdinalIgnoreCase)
                    ? "web-clone"
                    : "task";

        if (string.IsNullOrWhiteSpace(projectFolder))
        {
            projectFolder = "task";
        }

        return normalizedLanguage switch
        {
            "html" => $"{projectFolder}/index.html",
            "css" => $"{projectFolder}/styles.css",
            "javascript" => $"{projectFolder}/app.js",
            "c" => $"{projectFolder}/main.c",
            "cpp" => $"{projectFolder}/main.cpp",
            "csharp" => $"{projectFolder}/Program.cs",
            "java" => $"{projectFolder}/Main.java",
            "kotlin" => $"{projectFolder}/Main.kt",
            "bash" => $"{projectFolder}/run.sh",
            _ => $"{projectFolder}/main.py"
        };
    }

    private static bool TryGenerateDeterministicUiCloneScaffold(
        string objective,
        string workspaceRoot,
        out IReadOnlyList<ScaffoldFileSpec> files
    )
    {
        files = Array.Empty<ScaffoldFileSpec>();
        var text = (objective ?? string.Empty).ToLowerInvariant();
        var isUiClone = ContainsAny(
            text,
            "클론",
            "clone",
            "ui",
            "레이아웃",
            "html",
            "css",
            "landing",
            "페이지"
        );
        if (!isUiClone)
        {
            return false;
        }

        var domainMatch = DomainRegex.Match(text);
        var folder = domainMatch.Success ? SanitizePathSegment(domainMatch.Groups[1].Value) : "web-clone";
        if (string.IsNullOrWhiteSpace(folder))
        {
            folder = "web-clone";
        }

        var indexPath = $"{folder}/index.html";
        var cssPath = $"{folder}/styles.css";
        var jsPath = $"{folder}/script.js";

        var indexContent = $"""
                            <!doctype html>
                            <html lang="ko">
                            <head>
                              <meta charset="utf-8" />
                              <meta name="viewport" content="width=device-width, initial-scale=1" />
                              <title>{folder} UI Clone</title>
                              <link rel="stylesheet" href="styles.css" />
                            </head>
                            <body>
                              <header class="topbar">
                                <div class="logo">{folder.ToUpperInvariant()}</div>
                                <nav class="menu">
                                  <a href="#">메일</a>
                                  <a href="#">카페</a>
                                  <a href="#">블로그</a>
                                  <a href="#">쇼핑</a>
                                </nav>
                              </header>
                              <main class="layout">
                                <section class="hero">
                                  <h1>{folder} 클론 UI</h1>
                                  <p>요청에 따라 실제 기능은 제외하고 화면만 구현된 버전입니다.</p>
                                </section>
                                <section class="grid">
                                  <article class="card">콘텐츠 카드 1</article>
                                  <article class="card">콘텐츠 카드 2</article>
                                  <article class="card">콘텐츠 카드 3</article>
                                </section>
                              </main>
                              <script src="script.js"></script>
                            </body>
                            </html>
                            """;
        var cssContent = """
                         * { box-sizing: border-box; }
                         body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', sans-serif; background: #f4f6f8; color: #1f2937; }
                         .topbar { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: #ffffff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; }
                         .logo { font-weight: 800; color: #03c75a; letter-spacing: 0.04em; }
                         .menu { display: flex; gap: 16px; }
                         .menu a { text-decoration: none; color: #374151; font-size: 14px; }
                         .layout { max-width: 1080px; margin: 24px auto; padding: 0 16px; }
                         .hero { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
                         .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
                         .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; min-height: 140px; padding: 16px; }
                         """;
        var jsContent = """
                        document.addEventListener('DOMContentLoaded', () => {
                          console.log('UI clone rendered.');
                        });
                        """;

        files = new[]
        {
            new ScaffoldFileSpec(indexPath, indexContent),
            new ScaffoldFileSpec(cssPath, cssContent),
            new ScaffoldFileSpec(jsPath, jsContent)
        };
        return true;
    }

    private static string SanitizePathSegment(string raw)
    {
        var value = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' || ch == '.')
            {
                builder.Append(ch);
            }
        }

        return builder.Length == 0 ? string.Empty : builder.ToString();
    }

    private static bool IsKnownCodingActionType(string value)
    {
        return value == "mkdir"
               || value == "write_file"
               || value == "append_file"
               || value == "read_file"
               || value == "delete_file"
               || value == "run";
    }

    private static string NormalizeCodingActionType(string? rawType, string? path, string? content, string? command)
    {
        var raw = (rawType ?? string.Empty).Trim().ToLowerInvariant();
        if (IsKnownCodingActionType(raw))
        {
            return raw;
        }

        if (raw.Contains('|', StringComparison.Ordinal))
        {
            var split = raw.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var token in split)
            {
                if (IsKnownCodingActionType(token))
                {
                    return token;
                }
            }
        }

        if (raw.Contains("mkdir", StringComparison.Ordinal))
        {
            return "mkdir";
        }

        if (raw.Contains("append", StringComparison.Ordinal))
        {
            return "append_file";
        }

        if (raw.Contains("write", StringComparison.Ordinal) || raw.Contains("create", StringComparison.Ordinal))
        {
            return "write_file";
        }

        if (raw.Contains("read", StringComparison.Ordinal))
        {
            return "read_file";
        }

        if (raw.Contains("delete", StringComparison.Ordinal) || raw.Contains("remove", StringComparison.Ordinal))
        {
            return "delete_file";
        }

        if (raw.Contains("run", StringComparison.Ordinal) || raw.Contains("exec", StringComparison.Ordinal))
        {
            return "run";
        }

        var normalizedCommand = (command ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(normalizedCommand))
        {
            return "run";
        }

        var normalizedPath = (path ?? string.Empty).Trim();
        var normalizedContent = (content ?? string.Empty);
        if (!string.IsNullOrWhiteSpace(normalizedPath))
        {
            var hasContent = !string.IsNullOrWhiteSpace(normalizedContent);
            if (hasContent)
            {
                return "write_file";
            }

            if (!Path.HasExtension(normalizedPath))
            {
                return "mkdir";
            }

            return "write_file";
        }

        return "run";
    }

    private int GetCodingPlanMaxOutputTokens(string provider)
    {
        if (string.Equals(provider, "groq", StringComparison.OrdinalIgnoreCase)
            || string.Equals(provider, "gemini", StringComparison.OrdinalIgnoreCase)
            || string.Equals(provider, "cerebras", StringComparison.OrdinalIgnoreCase))
        {
            return Math.Clamp(_config.CodingMaxOutputTokens, 1200, 3200);
        }

        return Math.Clamp(_config.CodingMaxOutputTokens, 1200, 2400);
    }

    private int ResolveMaxIterations(string provider, bool oneShotMode)
    {
        if (oneShotMode)
        {
            return 1;
        }

        return Math.Max(2, _config.CodingAgentMaxIterations);
    }

    private int ResolveMaxActions(string provider, bool oneShotMode)
    {
        if (oneShotMode)
        {
            return Math.Max(4, _config.CodingAgentMaxActionsPerIteration);
        }

        if (string.Equals(provider, "copilot", StringComparison.OrdinalIgnoreCase))
        {
            var copilotActions = Math.Max(1, _config.CodingCopilotMaxActionsPerIteration);
            return Math.Min(Math.Max(1, _config.CodingAgentMaxActionsPerIteration), copilotActions);
        }

        return Math.Max(1, _config.CodingAgentMaxActionsPerIteration);
    }

    private const int VisibleCodingStageTotal = 6;

    private static CodingProgressUpdate BuildCodingProgressUpdate(
        string progressMode,
        string provider,
        string model,
        string phase,
        string message,
        int iteration,
        int maxIterations,
        int percent,
        bool done,
        string stageKey = "",
        string stageTitle = "",
        string stageDetail = "",
        int stageIndex = 0,
        int stageTotal = 0
    )
    {
        return new CodingProgressUpdate(
            progressMode,
            provider,
            model,
            phase,
            message,
            iteration,
            maxIterations,
            percent,
            done,
            stageKey,
            stageTitle,
            stageDetail,
            stageIndex,
            stageTotal
        );
    }

    private static string BuildCodingObjectiveProgressDetail(string objective, string languageHint)
    {
        var compact = Regex.Replace((objective ?? string.Empty).Trim(), @"\s+", " ");
        if (compact.Length > 180)
        {
            compact = compact[..180] + "...";
        }

        var language = string.IsNullOrWhiteSpace(languageHint) ? "auto" : languageHint.Trim();
        return string.IsNullOrWhiteSpace(compact)
            ? $"언어 힌트: {language}"
            : $"{compact} · 언어 힌트: {language}";
    }

    private static string BuildWorkspaceProgressDetail(string workspaceSnapshot)
    {
        var lines = (workspaceSnapshot ?? string.Empty)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length == 0)
        {
            return "워크스페이스 스냅샷 없음";
        }

        var headline = lines[0];
        if (headline.StartsWith("total_files=", StringComparison.OrdinalIgnoreCase))
        {
            return $"작업공간 점검 완료 · {headline.Replace("total_files=", "파일 수 ", StringComparison.OrdinalIgnoreCase)}";
        }

        return TrimForOutput(headline, 180);
    }

    private static string BuildCodingPlanProgressDetail(CodingLoopPlan plan, IReadOnlyList<CodingLoopAction> actions, bool hasDeferredRunAction)
    {
        var parts = new List<string>();
        var analysis = Regex.Replace((plan.Analysis ?? string.Empty).Trim(), @"\s+", " ");
        if (!string.IsNullOrWhiteSpace(analysis))
        {
            parts.Add(TrimForOutput(analysis, 180));
        }

        var targetPaths = actions
            .Where(action => !string.Equals(action.Type, "run", StringComparison.OrdinalIgnoreCase))
            .Select(action => (action.Path ?? string.Empty).Trim())
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(4)
            .ToArray();
        if (targetPaths.Length > 0)
        {
            parts.Add("대상 파일: " + string.Join(", ", targetPaths));
        }

        if (hasDeferredRunAction)
        {
            parts.Add("실행은 마지막 단계에서 1회만 수행");
        }

        return parts.Count == 0 ? "이번 반복 구현 계획을 정리했습니다." : string.Join(" · ", parts);
    }

    private static string BuildCodingWriteProgressDetail(IReadOnlyCollection<string> changedPaths, bool hasDeferredRunAction)
    {
        var parts = new List<string>();
        if (changedPaths.Count > 0)
        {
            parts.Add($"변경 파일 {changedPaths.Count}개");
            parts.Add(string.Join(", ", changedPaths.Take(4)));
        }
        else
        {
            parts.Add("실제 파일 변경은 아직 없음");
        }

        if (hasDeferredRunAction)
        {
            parts.Add("중간 실행 없이 최종 검증만 예약");
        }

        return string.Join(" · ", parts.Where(part => !string.IsNullOrWhiteSpace(part)));
    }

    private bool ShouldUseOneShotMode(string provider, string objective, string languageHint)
    {
        if (!_config.CodingEnableOneShotUiClone)
        {
            return false;
        }

        if (!string.Equals(provider, "copilot", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var lang = NormalizeLanguageForCode(languageHint);
        if (lang != "auto" && lang != "html" && lang != "javascript" && lang != "css" && lang != "python")
        {
            return false;
        }

        var text = (objective ?? string.Empty).ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var uiSignals = ContainsAny(
            text,
            "ui",
            "ux",
            "clone",
            "클론",
            "랜딩",
            "landing",
            "페이지",
            "프론트",
            "frontend",
            "html",
            "css",
            "화면",
            "레이아웃"
        );
        var backendSignals = ContainsAny(
            text,
            "api",
            "db",
            "database",
            "migration",
            "queue",
            "worker",
            "socket",
            "grpc",
            "redis",
            "kafka",
            "server"
        );

        return uiSignals && !backendSignals;
    }

    private string BuildRecentLoopLogs(IReadOnlyList<string> iterations, string provider)
    {
        if (iterations.Count == 0)
        {
            return string.Empty;
        }

        var keepCount = string.Equals(provider, "copilot", StringComparison.OrdinalIgnoreCase)
            ? Math.Max(1, _config.CodingRecentLoopHistoryForCopilot)
            : 4;
        var selected = iterations.TakeLast(keepCount).ToArray();
        for (var i = 0; i < selected.Length; i++)
        {
            selected[i] = TrimForOutput(selected[i], 500);
        }

        return string.Join("\n", selected);
    }

    private string BuildCodingLoopPrompt(
        string objective,
        string languageHint,
        string modeLabel,
        string workspaceRoot,
        string provider,
        bool oneShotMode,
        int iteration,
        int maxIterations,
        string workspaceSnapshot,
        string recentLogs,
        CodeExecutionResult lastExecution
    )
    {
        var builder = new StringBuilder();
        builder.AppendLine("너는 로컬 코딩 실행 에이전트다.");
        builder.AppendLine($"모드: {modeLabel}");
        builder.AppendLine($"모델 제공자: {provider}");
        builder.AppendLine($"반복: {iteration}/{maxIterations}");
        builder.AppendLine($"기준 작업 디렉터리: {workspaceRoot}");
        builder.AppendLine($"언어 힌트: {languageHint}");
        builder.AppendLine($"one-shot: {(oneShotMode ? "true" : "false")}");
        builder.AppendLine();
        builder.AppendLine("[목표]");
        builder.AppendLine(objective);
        builder.AppendLine();
        builder.AppendLine("[최근 실행 결과]");
        builder.AppendLine($"status={lastExecution.Status}");
        builder.AppendLine($"command={lastExecution.Command}");
        builder.AppendLine($"stdout={TrimForOutput(lastExecution.StdOut, 1200)}");
        builder.AppendLine($"stderr={TrimForOutput(lastExecution.StdErr, 1200)}");
        builder.AppendLine();
        builder.AppendLine("[최근 루프 로그]");
        builder.AppendLine(string.IsNullOrWhiteSpace(recentLogs) ? "(none)" : recentLogs);
        builder.AppendLine();
        builder.AppendLine("[워크스페이스 스냅샷]");
        builder.AppendLine(workspaceSnapshot);
        builder.AppendLine();
        builder.AppendLine("반드시 JSON 객체만 출력하라. 마크다운/설명 금지.");
        builder.AppendLine("스키마:");
        builder.AppendLine("{\"analysis\":\"...\",\"done\":false,\"final_message\":\"...\",\"actions\":[{\"type\":\"mkdir\",\"path\":\"상대경로\",\"content\":\"...\",\"command\":\"...\"}]}");
        builder.AppendLine("type 허용값: mkdir, write_file, append_file, read_file, delete_file, run");
        builder.AppendLine("주의: type을 `mkdir|write_file`처럼 합치지 말고 반드시 단일 값만 사용");
        builder.AppendLine($"제약: actions 최대 {_config.CodingAgentMaxActionsPerIteration}개");
        builder.AppendLine("규칙:");
        builder.AppendLine("- analysis에는 이번 반복에서 무엇을 만들고 어떤 파일을 건드릴지 짧게 적는다");
        builder.AppendLine("- done=false 이면 actions에 최소 1개의 실질 액션(mkdir/write_file/append_file/read_file/delete_file/run)을 반드시 넣는다");
        builder.AppendLine("- 경로는 가능하면 상대경로 사용");
        builder.AppendLine("- run은 마지막 검증 단계에서 1회만 수행되므로 중간 반복에서는 가능한 한 넣지 말고 파일 생성/수정에 집중");
        builder.AppendLine("- JSON 문자열 내부 줄바꿈은 반드시 \\n 으로 이스케이프");
        builder.AppendLine("- 가능한 한 한 번에 필요한 파일을 모두 생성하고, 마지막 검증(run) 1회만 수행");
        builder.AppendLine("- 실행 성공 및 요구사항 충족 시 즉시 done=true, actions=[]");
        builder.AppendLine("- 오류가 있으면 원인 수정 액션을 포함");
        builder.AppendLine("- 목표 달성 시 done=true");
        return builder.ToString().Trim();
    }

    private static string BuildCodingAgentObjectivePrompt(string input, string languageHint, string modeLabel)
    {
        return $"""
                목표: 사용자의 코딩 요청을 로컬 프로젝트에서 실제로 완성하세요.
                모드: {modeLabel}
                언어 힌트: {languageHint}
                요구사항:
                - 기존 파일 구조를 우선 존중하고 필요한 최소 범위만 수정
                - 필요한 폴더/파일 생성 및 수정
                - 빌드/컴파일/실행/테스트 수행
                - 오류 발생 시 원인 분석 후 수정 반복
                - 더미 구현, TODO만 남기는 미완성 결과, 가짜 성공 보고 금지
                - 실패한 명령을 같은 형태로 반복하지 말고 원인을 바꿔 수정
                - 최종 요약에는 실제 변경 내용과 검증 결과만 반영
                - 최종적으로 실행 가능한 상태를 목표로 진행

                사용자 요청:
                {input}
                """;
    }

    private static string BuildDraftCodingWorkerPrompt(string objective, string languageHint)
    {
        return $"""
                너는 병렬 코딩 워커 초안 생성기다.
                실제 파일 수정/삭제/실행은 하지 말고 최종 통합용 초안만 작성하라.
                언어 힌트: {languageHint}

                [작업 목표]
                {objective}

                규칙:
                - 가장 가능성 높은 구현안 1개만 제시
                - 불필요한 서론, 사과, 메타 설명 금지
                - 필요한 파일은 상대경로로 적기
                - 더미 코드, TODO, 의사코드 금지
                - 마지막에는 반드시 LANGUAGE=<언어> 줄과 최소 1개의 코드블록 포함
                - 여러 파일이 필요하면 `FILE: 상대경로` 줄 다음에 코드블록을 이어서 작성

                출력 형식:
                [요약]
                - 핵심 구현 전략
                [파일]
                - 상대경로: 역할
                [리스크]
                - 남는 위험 또는 검증 포인트
                LANGUAGE=<언어>
                FILE: <핵심 파일 상대경로>
                ```<언어>
                // 핵심 코드
                ```
                """;
    }

    private string BuildWorkspaceSnapshot(string workspaceRoot, string provider)
    {
        try
        {
            if (!Directory.Exists(workspaceRoot))
            {
                return "(workspace not found)";
            }

            var maxEntries = Math.Max(
                20,
                string.Equals(provider, "copilot", StringComparison.OrdinalIgnoreCase)
                    ? Math.Min(_config.CodingWorkspaceSnapshotMaxEntries, 60)
                    : _config.CodingWorkspaceSnapshotMaxEntries
            );
            var files = Directory.EnumerateFiles(workspaceRoot, "*", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(workspaceRoot, path))
                .Where(path => !path.StartsWith(".git", StringComparison.OrdinalIgnoreCase))
                .Where(path => !path.StartsWith("node_modules", StringComparison.OrdinalIgnoreCase))
                .Where(path => !path.StartsWith("bin/", StringComparison.OrdinalIgnoreCase))
                .Where(path => !path.StartsWith("obj/", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (files.Length == 0)
            {
                return "(empty)";
            }

            var lines = new List<string>();
            lines.Add($"total_files={files.Length}");
            foreach (var relative in files.Take(maxEntries))
            {
                var fullPath = Path.Combine(workspaceRoot, relative);
                long size = 0;
                try
                {
                    size = new FileInfo(fullPath).Length;
                }
                catch
                {
                }

                lines.Add($"{relative} ({size}B)");
            }

            if (files.Length > maxEntries)
            {
                lines.Add($"... +{files.Length - maxEntries} files");
            }

            return string.Join("\n", lines);
        }
        catch (Exception ex)
        {
            return $"(snapshot error: {ex.Message})";
        }
    }

    private string ResolveWorkspaceRoot()
    {
        var configured = string.IsNullOrWhiteSpace(_config.WorkspaceRootDir)
            ? Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), ".."))
            : _config.WorkspaceRootDir;
        var fullPath = Path.GetFullPath(configured);
        try
        {
            Directory.CreateDirectory(fullPath);
        }
        catch
        {
        }

        return fullPath;
    }

    private static bool IsPathUnderRoot(string candidatePath, string rootPath)
    {
        var fullRoot = Path.GetFullPath(rootPath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullCandidate = Path.GetFullPath(candidatePath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (string.Equals(fullCandidate, fullRoot, comparison))
        {
            return true;
        }

        var rootWithSlash = fullRoot + Path.DirectorySeparatorChar;
        return fullCandidate.StartsWith(rootWithSlash, comparison);
    }

    private static string? ResolveActionPathOrFallback(string actionType, string? path, string? content)
    {
        var normalizedPath = (path ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(normalizedPath))
        {
            return normalizedPath;
        }

        if (actionType == "write_file" || actionType == "append_file")
        {
            return InferFallbackPathForGeneratedCode(content);
        }

        return null;
    }

    private static string InferFallbackPathForGeneratedCode(string? content)
    {
        var lowered = (content ?? string.Empty).ToLowerInvariant();
        if (lowered.Contains("<!doctype html", StringComparison.Ordinal)
            || lowered.Contains("<html", StringComparison.Ordinal))
        {
            return "index.html";
        }

        if (lowered.Contains("using system;", StringComparison.Ordinal)
            || lowered.Contains("namespace ", StringComparison.Ordinal))
        {
            return "Program.cs";
        }

        if (lowered.Contains("#!/usr/bin/env bash", StringComparison.Ordinal)
            || lowered.Contains("set -e", StringComparison.Ordinal)
            || lowered.Contains("echo ", StringComparison.Ordinal))
        {
            return "run.sh";
        }

        if (lowered.Contains("function ", StringComparison.Ordinal)
            || lowered.Contains("console.log(", StringComparison.Ordinal)
            || lowered.Contains("=>", StringComparison.Ordinal))
        {
            return "main.js";
        }

        return "main.py";
    }

    private static string ResolveWorkspacePath(string workspaceRoot, string? relativeOrAbsolutePath)
    {
        var raw = (relativeOrAbsolutePath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new InvalidOperationException("path is required");
        }

        if (Path.IsPathRooted(raw))
        {
            return Path.GetFullPath(raw);
        }

        return Path.GetFullPath(Path.Combine(workspaceRoot, raw));
    }

    private static string BuildVerificationCommand(string language, IReadOnlyCollection<string> changedFiles, string workspaceRoot)
    {
        var firstFile = changedFiles
            .FirstOrDefault(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        if (string.IsNullOrWhiteSpace(firstFile))
        {
            return string.Empty;
        }

        var safePath = firstFile.Replace("'", "'\"'\"'", StringComparison.Ordinal);
        var normalizedLanguage = NormalizeLanguageForCode(language);
        if (normalizedLanguage == "python")
        {
            return $"python3 -m py_compile '{safePath}'";
        }

        if (normalizedLanguage == "javascript")
        {
            return $"if command -v node >/dev/null 2>&1; then node --check '{safePath}'; else echo 'node 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "c")
        {
            return $"if command -v cc >/dev/null 2>&1; then cc -fsyntax-only '{safePath}'; else echo 'cc 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "cpp")
        {
            return $"if command -v c++ >/dev/null 2>&1; then c++ -fsyntax-only '{safePath}'; elif command -v g++ >/dev/null 2>&1; then g++ -fsyntax-only '{safePath}'; else echo 'c++ 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "csharp")
        {
            return "if command -v dotnet >/dev/null 2>&1; then dotnet --info >/dev/null; echo 'dotnet 확인 완료'; else echo 'dotnet 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "java")
        {
            return $"if command -v javac >/dev/null 2>&1; then javac -Xlint:none '{safePath}'; else echo 'javac 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "kotlin")
        {
            return "if command -v kotlinc >/dev/null 2>&1; then echo 'kotlinc 확인 완료'; else echo 'kotlinc 없음, 파일 생성 확인'; fi";
        }

        if (normalizedLanguage == "html" || normalizedLanguage == "css")
        {
            return $"test -f '{safePath}' && echo '정적 파일 생성 확인: {Path.GetFileName(firstFile)}'";
        }

        if (normalizedLanguage == "bash")
        {
            return $"if command -v bash >/dev/null 2>&1; then bash -n '{safePath}'; else echo 'bash 없음, 파일 생성 확인'; fi";
        }

        var workspaceSafe = workspaceRoot.Replace("'", "'\"'\"'", StringComparison.Ordinal);
        return $"cd '{workspaceSafe}' && ls -la";
    }

    private static string NormalizePythonCommandForShell(string command)
    {
        var raw = command ?? string.Empty;
        var trimmed = raw.TrimStart();
        if (OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(trimmed))
        {
            return raw;
        }

        if (!trimmed.StartsWith("python", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("python3", StringComparison.OrdinalIgnoreCase))
        {
            return raw;
        }

        if (trimmed.Length > "python".Length)
        {
            var next = trimmed["python".Length];
            if (!char.IsWhiteSpace(next))
            {
                return raw;
            }
        }

        var prefixLength = raw.Length - trimmed.Length;
        var suffix = trimmed.Length > "python".Length ? trimmed["python".Length..] : string.Empty;
        return new string(' ', prefixLength) + "python3" + suffix;
    }

    private async Task<ShellRunResult> RunWorkspaceCommandWithAutoInstallAsync(string command, string workDir, CancellationToken cancellationToken)
    {
        var installLogs = new List<string>();
        var installErrors = new List<string>();

        await EnsureWorkspaceDependenciesAsync(command, workDir, installLogs, installErrors, cancellationToken);
        var shell = await RunWorkspaceCommandAsync(command, workDir, cancellationToken);

        if (!shell.TimedOut && shell.ExitCode != 0)
        {
            var retried = await TryInstallMissingDependencyFromErrorAsync(command, workDir, shell.StdErr, installLogs, installErrors, cancellationToken);
            if (retried)
            {
                shell = await RunWorkspaceCommandAsync(command, workDir, cancellationToken);
            }
        }

        if (installLogs.Count == 0 && installErrors.Count == 0)
        {
            return shell;
        }

        var mergedStdOut = MergeInstallLogs("[auto-install]", installLogs, shell.StdOut);
        var mergedStdErr = MergeInstallLogs("[auto-install]", installErrors, shell.StdErr);
        return new ShellRunResult(shell.ExitCode, mergedStdOut, mergedStdErr, shell.TimedOut);
    }

    private async Task EnsureWorkspaceDependenciesAsync(
        string command,
        string workDir,
        List<string> logs,
        List<string> errors,
        CancellationToken cancellationToken
    )
    {
        try
        {
            if (LooksLikePythonCommand(command))
            {
                var pythonBaseDir = ResolveDependencyBaseDirectory(command, workDir, ".py");
                var requirementsPath = FindRequirementsFile(pythonBaseDir, workDir);
                if (!string.IsNullOrWhiteSpace(requirementsPath) && File.Exists(requirementsPath))
                {
                    var pipCommand = $"python3 -m pip install --disable-pip-version-check -r {EscapeShellArg(requirementsPath)}";
                    var installResult = await RunWorkspaceCommandAsync(pipCommand, workDir, cancellationToken);
                    AppendInstallOutcome("requirements.txt 설치", pipCommand, installResult, logs, errors);
                }

                var pythonScriptPath = TryExtractScriptPath(command, workDir, ".py");
                if (!string.IsNullOrWhiteSpace(pythonScriptPath) && File.Exists(pythonScriptPath))
                {
                    var packages = ExtractPythonPackagesFromSource(pythonScriptPath);
                    if (packages.Count > 0)
                    {
                        var pipCommand = $"python3 -m pip install --disable-pip-version-check {string.Join(" ", packages.Select(EscapeShellArg))}";
                        var installResult = await RunWorkspaceCommandAsync(pipCommand, workDir, cancellationToken);
                        AppendInstallOutcome("Python import 패키지 설치", pipCommand, installResult, logs, errors);
                    }
                }
            }

            if (LooksLikeNodeCommand(command))
            {
                var nodeBaseDir = ResolveDependencyBaseDirectory(command, workDir, ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx");
                var packageJsonPath = Path.Combine(nodeBaseDir, "package.json");
                if (File.Exists(packageJsonPath))
                {
                    var nodeModulesPath = Path.Combine(nodeBaseDir, "node_modules");
                    if (!Directory.Exists(nodeModulesPath))
                    {
                        var npmInstallCommand = "npm install --no-fund --no-audit";
                        var installResult = await RunWorkspaceCommandAsync(npmInstallCommand, nodeBaseDir, cancellationToken);
                        AppendInstallOutcome("package.json 의존성 설치", npmInstallCommand, installResult, logs, errors);
                    }
                }

                var nodeScriptPath = TryExtractScriptPath(command, workDir, ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx");
                if (!string.IsNullOrWhiteSpace(nodeScriptPath) && File.Exists(nodeScriptPath))
                {
                    var packages = ExtractNodePackagesFromSource(nodeScriptPath);
                    if (packages.Count > 0)
                    {
                        var npmCommand = $"npm install --no-save {string.Join(" ", packages.Select(EscapeShellArg))}";
                        var installResult = await RunWorkspaceCommandAsync(npmCommand, nodeBaseDir, cancellationToken);
                        AppendInstallOutcome("Node import 패키지 설치", npmCommand, installResult, logs, errors);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            errors.Add($"의존성 자동 설치 파이프라인 내부 오류: {ex.Message}");
        }
    }

    private async Task<bool> TryInstallMissingDependencyFromErrorAsync(
        string command,
        string workDir,
        string stdErr,
        List<string> logs,
        List<string> errors,
        CancellationToken cancellationToken
    )
    {
        try
        {
            if (LooksLikePythonCommand(command))
            {
                var missingModule = ExtractPythonMissingModule(stdErr);
                if (IsPythonSystemModule(missingModule))
                {
                    var installedSystemModule = await TryInstallPythonSystemModuleAsync(missingModule!, workDir, logs, errors, cancellationToken);
                    if (installedSystemModule)
                    {
                        return true;
                    }
                }

                var pythonPackage = ResolvePythonPackageName(missingModule);
                if (!string.IsNullOrWhiteSpace(pythonPackage))
                {
                    var pipCommand = $"python3 -m pip install --disable-pip-version-check {EscapeShellArg(pythonPackage)}";
                    var installResult = await RunWorkspaceCommandAsync(pipCommand, workDir, cancellationToken);
                    AppendInstallOutcome($"Python 누락 모듈 설치({pythonPackage})", pipCommand, installResult, logs, errors);
                    if (installResult.ExitCode == 0)
                    {
                        return true;
                    }
                }
            }

            if (LooksLikeNodeCommand(command))
            {
                var missingSpecifier = ExtractNodeMissingModule(stdErr);
                var nodePackage = ResolveNodePackageName(missingSpecifier);
                if (!string.IsNullOrWhiteSpace(nodePackage))
                {
                    var nodeBaseDir = ResolveDependencyBaseDirectory(command, workDir, ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx");
                    var npmCommand = $"npm install --no-save {EscapeShellArg(nodePackage)}";
                    var installResult = await RunWorkspaceCommandAsync(npmCommand, nodeBaseDir, cancellationToken);
                    AppendInstallOutcome($"Node 누락 모듈 설치({nodePackage})", npmCommand, installResult, logs, errors);
                    if (installResult.ExitCode == 0)
                    {
                        return true;
                    }
                }
            }

            var missingProgram = ExtractMissingProgram(stdErr);
            if (!string.IsNullOrWhiteSpace(missingProgram) && !ProgramInstallDenyList.Contains(missingProgram))
            {
                var installed = await TryInstallProgramAsync(missingProgram, workDir, logs, errors, cancellationToken);
                if (installed)
                {
                    return true;
                }
            }
        }
        catch (Exception ex)
        {
            errors.Add($"누락 의존성 자동 설치 오류: {ex.Message}");
        }

        return false;
    }

    private static bool IsPythonSystemModule(string? moduleName)
    {
        return string.Equals(moduleName, "tkinter", StringComparison.OrdinalIgnoreCase)
               || string.Equals(moduleName, "_tkinter", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<bool> TryInstallPythonSystemModuleAsync(
        string moduleName,
        string workDir,
        List<string> logs,
        List<string> errors,
        CancellationToken cancellationToken
    )
    {
        if (!IsPythonSystemModule(moduleName))
        {
            return false;
        }

        if (OperatingSystem.IsMacOS())
        {
            var brewCheck = await RunWorkspaceCommandAsync("command -v brew >/dev/null 2>&1", workDir, cancellationToken);
            if (brewCheck.ExitCode != 0)
            {
                errors.Add("tkinter 자동 설치 건너뜀: brew 없음");
                return false;
            }

            var versionResult = await RunWorkspaceCommandAsync(
                "python3 - <<'PY'\nimport sys\nprint(f\"{sys.version_info.major}.{sys.version_info.minor}\")\nPY",
                workDir,
                cancellationToken
            );
            var version = versionResult.ExitCode == 0 ? versionResult.StdOut.Trim() : string.Empty;
            var formulaCandidates = new List<string>();
            if (!string.IsNullOrWhiteSpace(version))
            {
                formulaCandidates.Add($"python-tk@{version}");
            }

            formulaCandidates.Add("python-tk");
            foreach (var formula in formulaCandidates.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var brewInstall = $"brew install {EscapeShellArg(formula)}";
                var installResult = await RunWorkspaceCommandAsync(brewInstall, workDir, cancellationToken);
                AppendInstallOutcome($"tkinter 시스템 패키지 설치({formula})", brewInstall, installResult, logs, errors);
                if (installResult.ExitCode == 0)
                {
                    return true;
                }
            }

            return false;
        }

        if (OperatingSystem.IsLinux())
        {
            var aptCheck = await RunWorkspaceCommandAsync("command -v apt-get >/dev/null 2>&1", workDir, cancellationToken);
            if (aptCheck.ExitCode != 0)
            {
                errors.Add("tkinter 자동 설치 건너뜀: apt-get 없음 (python3-tk)");
                return false;
            }

            var aptInstall = "if [ \"$(id -u)\" -eq 0 ]; then apt-get update && apt-get install -y python3-tk; elif command -v sudo >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y python3-tk; else exit 126; fi";
            var installResult = await RunWorkspaceCommandAsync(aptInstall, workDir, cancellationToken);
            AppendInstallOutcome("tkinter 시스템 패키지 설치(python3-tk)", aptInstall, installResult, logs, errors);
            return installResult.ExitCode == 0;
        }

        errors.Add($"tkinter 자동 설치 미지원 OS ({moduleName})");
        return false;
    }

    private async Task<bool> TryInstallProgramAsync(
        string program,
        string workDir,
        List<string> logs,
        List<string> errors,
        CancellationToken cancellationToken
    )
    {
        var safeProgram = SanitizeProgramName(program);
        if (string.IsNullOrWhiteSpace(safeProgram))
        {
            return false;
        }

        if (OperatingSystem.IsMacOS())
        {
            var brewCheck = await RunWorkspaceCommandAsync("command -v brew >/dev/null 2>&1", workDir, cancellationToken);
            if (brewCheck.ExitCode != 0)
            {
                errors.Add($"프로그램 자동 설치 건너뜀: brew 없음 ({safeProgram})");
                return false;
            }

            var brewInstall = $"brew install {EscapeShellArg(safeProgram)}";
            var installResult = await RunWorkspaceCommandAsync(brewInstall, workDir, cancellationToken);
            AppendInstallOutcome($"brew 프로그램 설치({safeProgram})", brewInstall, installResult, logs, errors);
            return installResult.ExitCode == 0;
        }

        if (OperatingSystem.IsLinux())
        {
            var aptCheck = await RunWorkspaceCommandAsync("command -v apt-get >/dev/null 2>&1", workDir, cancellationToken);
            if (aptCheck.ExitCode != 0)
            {
                errors.Add($"프로그램 자동 설치 건너뜀: apt-get 없음 ({safeProgram})");
                return false;
            }

            var aptInstall = $"if [ \"$(id -u)\" -eq 0 ]; then apt-get update && apt-get install -y {EscapeShellArg(safeProgram)}; elif command -v sudo >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y {EscapeShellArg(safeProgram)}; else exit 126; fi";
            var installResult = await RunWorkspaceCommandAsync(aptInstall, workDir, cancellationToken);
            AppendInstallOutcome($"apt 프로그램 설치({safeProgram})", aptInstall, installResult, logs, errors);
            return installResult.ExitCode == 0;
        }

        errors.Add($"프로그램 자동 설치 미지원 OS ({safeProgram})");
        return false;
    }

    private static string? FindRequirementsFile(string primaryDir, string fallbackDir)
    {
        if (!string.IsNullOrWhiteSpace(primaryDir))
        {
            var primary = Path.Combine(primaryDir, "requirements.txt");
            if (File.Exists(primary))
            {
                return primary;
            }
        }

        var fallback = Path.Combine(fallbackDir, "requirements.txt");
        return File.Exists(fallback) ? fallback : null;
    }

    private static string ResolveDependencyBaseDirectory(string command, string workDir, params string[] extensions)
    {
        var scriptPath = TryExtractScriptPath(command, workDir, extensions);
        if (string.IsNullOrWhiteSpace(scriptPath))
        {
            return workDir;
        }

        var candidate = scriptPath;
        if (!Path.IsPathRooted(candidate))
        {
            candidate = Path.GetFullPath(Path.Combine(workDir, candidate));
        }

        if (Directory.Exists(candidate))
        {
            return candidate;
        }

        var parent = Path.GetDirectoryName(candidate);
        return string.IsNullOrWhiteSpace(parent) ? workDir : parent;
    }

    private static string? TryExtractScriptPath(string command, string workDir, params string[] extensions)
    {
        if (string.IsNullOrWhiteSpace(command) || extensions.Length == 0)
        {
            return null;
        }

        foreach (Match match in ShellTokenRegex.Matches(command))
        {
            var token = match.Groups["sq"].Success
                ? match.Groups["sq"].Value
                : match.Groups["dq"].Success
                    ? match.Groups["dq"].Value
                    : match.Groups["bare"].Value;
            if (string.IsNullOrWhiteSpace(token))
            {
                continue;
            }

            if (!extensions.Any(ext => token.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            if (Path.IsPathRooted(token))
            {
                return token;
            }

            return Path.GetFullPath(Path.Combine(workDir, token));
        }

        return null;
    }

    private static List<string> ExtractPythonPackagesFromSource(string scriptPath)
    {
        string text;
        try
        {
            text = File.ReadAllText(scriptPath);
        }
        catch
        {
            return new List<string>();
        }

        var scriptDir = Path.GetDirectoryName(scriptPath) ?? string.Empty;
        var modules = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in PythonImportRegex.Matches(text))
        {
            var parts = (match.Groups["mods"].Value ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var part in parts)
            {
                var tokenParts = part.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (tokenParts.Length == 0)
                {
                    continue;
                }

                var token = tokenParts[0];
                var rootParts = token.Split('.', StringSplitOptions.RemoveEmptyEntries);
                if (rootParts.Length == 0)
                {
                    continue;
                }

                var root = rootParts[0];
                if (!string.IsNullOrWhiteSpace(root))
                {
                    modules.Add(root);
                }
            }
        }

        foreach (Match match in PythonFromImportRegex.Matches(text))
        {
            var rootParts = (match.Groups["mod"].Value ?? string.Empty)
                .Split('.', StringSplitOptions.RemoveEmptyEntries);
            if (rootParts.Length == 0)
            {
                continue;
            }

            var root = rootParts[0];
            if (!string.IsNullOrWhiteSpace(root))
            {
                modules.Add(root);
            }
        }

        var packages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var module in modules)
        {
            if (PythonStdlibModules.Contains(module))
            {
                continue;
            }

            var localModulePath = Path.Combine(scriptDir, module + ".py");
            var localPackagePath = Path.Combine(scriptDir, module);
            if (File.Exists(localModulePath) || Directory.Exists(localPackagePath))
            {
                continue;
            }

            var package = ResolvePythonPackageName(module);
            if (!string.IsNullOrWhiteSpace(package))
            {
                packages.Add(package);
            }
        }

        return packages.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static List<string> ExtractNodePackagesFromSource(string scriptPath)
    {
        string text;
        try
        {
            text = File.ReadAllText(scriptPath);
        }
        catch
        {
            return new List<string>();
        }

        var packages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in NodeImportRegex.Matches(text))
        {
            var specifier = match.Groups["mod"].Success
                ? match.Groups["mod"].Value
                : match.Groups["mod2"].Success
                    ? match.Groups["mod2"].Value
                    : match.Groups["mod3"].Value;
            var package = ResolveNodePackageName(specifier);
            if (!string.IsNullOrWhiteSpace(package))
            {
                packages.Add(package);
            }
        }

        return packages.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static string? ResolvePythonPackageName(string? moduleName)
    {
        var rootParts = (moduleName ?? string.Empty)
            .Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (rootParts.Length == 0)
        {
            return null;
        }

        var root = rootParts[0].Trim();
        if (string.IsNullOrWhiteSpace(root))
        {
            return null;
        }

        if (IsPythonSystemModule(root))
        {
            return null;
        }

        if (PythonModulePackageMap.TryGetValue(root, out var mapped))
        {
            return mapped;
        }

        return Regex.IsMatch(root, "^[A-Za-z0-9._-]+$") ? root : null;
    }

    private static string? ResolveNodePackageName(string? specifier)
    {
        var raw = (specifier ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)
            || raw.StartsWith("./", StringComparison.Ordinal)
            || raw.StartsWith("../", StringComparison.Ordinal)
            || raw.StartsWith("/", StringComparison.Ordinal)
            || raw.StartsWith("node:", StringComparison.OrdinalIgnoreCase)
            || raw.StartsWith("file:", StringComparison.OrdinalIgnoreCase)
            || raw.StartsWith("http:", StringComparison.OrdinalIgnoreCase)
            || raw.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string package;
        if (raw.StartsWith("@", StringComparison.Ordinal))
        {
            var segments = raw.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length < 2)
            {
                return null;
            }

            package = $"{segments[0]}/{segments[1]}";
        }
        else
        {
            var segments = raw.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0)
            {
                return null;
            }

            package = segments[0];
        }

        if (NodeBuiltinModules.Contains(package))
        {
            return null;
        }

        return Regex.IsMatch(package, "^@?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)?$") ? package : null;
    }

    private static string? ExtractPythonMissingModule(string stderr)
    {
        if (string.IsNullOrWhiteSpace(stderr))
        {
            return null;
        }

        var moduleNotFoundMatch = PythonModuleNotFoundRegex.Match(stderr);
        if (moduleNotFoundMatch.Success)
        {
            return moduleNotFoundMatch.Groups["module"].Value;
        }

        var importErrorMatch = PythonImportErrorRegex.Match(stderr);
        return importErrorMatch.Success ? importErrorMatch.Groups["module"].Value : null;
    }

    private static string? ExtractNodeMissingModule(string stderr)
    {
        if (string.IsNullOrWhiteSpace(stderr))
        {
            return null;
        }

        var match = NodeModuleNotFoundRegex.Match(stderr);
        if (!match.Success)
        {
            return null;
        }

        return match.Groups["module"].Success ? match.Groups["module"].Value : match.Groups["module2"].Value;
    }

    private static string? ExtractMissingProgram(string stderr)
    {
        if (string.IsNullOrWhiteSpace(stderr))
        {
            return null;
        }

        var match = CommandNotFoundRegex.Match(stderr);
        if (!match.Success)
        {
            return null;
        }

        var candidate = match.Groups["cmd"].Success ? match.Groups["cmd"].Value : match.Groups["cmd2"].Value;
        return SanitizeProgramName(candidate);
    }

    private static bool LooksLikePythonCommand(string command)
    {
        var lowered = (command ?? string.Empty).ToLowerInvariant();
        return lowered.Contains("python", StringComparison.Ordinal);
    }

    private static bool LooksLikeNodeCommand(string command)
    {
        var lowered = (command ?? string.Empty).ToLowerInvariant();
        return lowered.Contains("node", StringComparison.Ordinal)
               || lowered.Contains("npm", StringComparison.Ordinal)
               || lowered.Contains("pnpm", StringComparison.Ordinal)
               || lowered.Contains("yarn", StringComparison.Ordinal)
               || lowered.Contains("tsx", StringComparison.Ordinal)
               || lowered.Contains("ts-node", StringComparison.Ordinal);
    }

    private static string? SanitizeProgramName(string? value)
    {
        var token = (value ?? string.Empty).Trim();
        return Regex.IsMatch(token, "^[A-Za-z0-9][A-Za-z0-9+._-]{1,63}$") ? token : null;
    }

    private static void AppendInstallOutcome(
        string title,
        string installCommand,
        ShellRunResult result,
        List<string> logs,
        List<string> errors
    )
    {
        if (result.ExitCode == 0)
        {
            logs.Add($"{title}: ok");
            var stdout = TrimInstallLog(result.StdOut, 1000);
            if (!string.IsNullOrWhiteSpace(stdout))
            {
                logs.Add(stdout);
            }
            return;
        }

        errors.Add($"{title}: error(exit={result.ExitCode})");
        errors.Add($"command={installCommand}");
        var stderr = TrimInstallLog(result.StdErr, 1400);
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            errors.Add(stderr);
        }
    }

    private static string MergeInstallLogs(string header, IReadOnlyList<string> installLogs, string originalText)
    {
        if (installLogs.Count == 0)
        {
            return originalText ?? string.Empty;
        }

        var builder = new StringBuilder();
        builder.AppendLine(header);
        foreach (var line in installLogs)
        {
            builder.AppendLine(line);
        }

        if (!string.IsNullOrWhiteSpace(originalText))
        {
            builder.AppendLine();
            builder.Append(originalText.Trim());
        }

        return builder.ToString().Trim();
    }

    private static string TrimInstallLog(string text, int maxLength)
    {
        var value = (text ?? string.Empty).Trim();
        if (value.Length <= maxLength)
        {
            return value;
        }

        return value[..maxLength] + "\n...(truncated)";
    }

    private static string EscapeShellArg(string value)
    {
        return $"'{(value ?? string.Empty).Replace("'", "'\"'\"'", StringComparison.Ordinal)}'";
    }

    private async Task<ShellRunResult> RunWorkspaceCommandAsync(string command, string workDir, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/zsh",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workDir
        };

        var normalizedCommand = NormalizePythonCommandForShell(command);
        if (OperatingSystem.IsWindows())
        {
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(normalizedCommand);
        }
        else
        {
            startInfo.ArgumentList.Add("-lc");
            startInfo.ArgumentList.Add(normalizedCommand);
        }

        using var process = new Process { StartInfo = startInfo };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            return new ShellRunResult(127, string.Empty, ex.Message, false);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Max(20, _config.CodeExecutionTimeoutSec)));
        var stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
        var stderrTask = process.StandardError.ReadToEndAsync(timeoutCts.Token);

        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
            return new ShellRunResult(process.ExitCode, await stdoutTask, await stderrTask, false);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
            }

            string stdout;
            string stderr;
            try
            {
                stdout = await stdoutTask;
            }
            catch
            {
                stdout = string.Empty;
            }

            try
            {
                stderr = await stderrTask;
            }
            catch
            {
                stderr = string.Empty;
            }

            if (string.IsNullOrWhiteSpace(stderr))
            {
                stderr = "execution timed out";
            }

            return new ShellRunResult(124, stdout, stderr, true);
        }
    }

    private static string? GetStringProperty(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    private static bool GetBoolProperty(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return false;
        }

        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => value.GetString()?.Equals("true", StringComparison.OrdinalIgnoreCase) == true,
            _ => false
        };
    }

    private static string GuessLanguageFromPath(string path, string fallback)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return fallback;
        }

        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".py" => "python",
            ".js" or ".mjs" => "javascript",
            ".ts" => "javascript",
            ".c" => "c",
            ".cpp" or ".cc" or ".cxx" => "cpp",
            ".cs" => "csharp",
            ".java" => "java",
            ".kt" => "kotlin",
            ".html" or ".htm" => "html",
            ".css" => "css",
            ".sh" => "bash",
            _ => fallback
        };
    }

    private static string BuildOrchestrationCodingAggregatePrompt(
        string input,
        IReadOnlyList<CodingWorkerResult> workers,
        string languageHint
    )
    {
        return BuildParallelCodingAggregatePrompt(
            "오케스트레이션 통합",
            input,
            workers,
            languageHint,
            "역할별 초안의 장점을 취합해 한 번에 완성도 높은 최종 구현으로 정리"
        );
    }

    private static string BuildMultiCodingAggregatePrompt(
        string input,
        IReadOnlyList<CodingWorkerResult> workers,
        string languageHint
    )
    {
        return BuildParallelCodingAggregatePrompt(
            "다중 코딩 통합",
            input,
            workers,
            languageHint,
            "여러 모델 초안을 비교해 가장 안정적인 구현안을 선택하고 부족한 부분은 보완"
        );
    }

    private static string BuildParallelCodingAggregatePrompt(
        string modeLabel,
        string input,
        IReadOnlyList<CodingWorkerResult> workers,
        string languageHint,
        string strategyHint
    )
    {
        var builder = new StringBuilder();
        builder.AppendLine($"다음은 {modeLabel} 단계에서 수집한 병렬 워커 초안들입니다.");
        builder.AppendLine($"요청: {input}");
        builder.AppendLine($"언어 힌트: {languageHint}");
        builder.AppendLine($"통합 전략: {strategyHint}");
        builder.AppendLine();
        foreach (var worker in workers)
        {
            builder.AppendLine($"[Worker {worker.Provider}:{worker.Model}]");
            builder.AppendLine($"status={worker.Execution.Status} exit={worker.Execution.ExitCode} language={worker.Language}");
            if (worker.ChangedFiles.Count > 0)
            {
                builder.AppendLine("changed_files=" + string.Join(", ", worker.ChangedFiles.Take(6)));
            }

            var draft = (worker.RawResponse ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(draft))
            {
                builder.AppendLine("draft:");
                builder.AppendLine(TrimForOutput(draft, 2200));
            }
            else if (!string.IsNullOrWhiteSpace(worker.Code))
            {
                builder.AppendLine("code:");
                builder.AppendLine(TrimForOutput(worker.Code, 2200));
            }

            builder.AppendLine();
        }

        builder.AppendLine("요구사항:");
        builder.AppendLine("1) 워커 초안을 참고하되 그대로 복붙하지 말고 충돌과 중복을 정리");
        builder.AppendLine("2) 실제 워크스페이스에는 필요한 최소 파일만 생성/수정");
        builder.AppendLine("3) 더미 구현, TODO만 남는 미완성 결과, 가짜 성공 보고 금지");
        builder.AppendLine("4) 최종 실행/검증까지 마칠 수 있는 현실적인 구현을 선택");
        return builder.ToString().Trim();
    }

    private static string BuildMultiCodingSummaryPrompt(string originalInput, IReadOnlyList<CodingWorkerResult> workers)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"원본 요청: {originalInput}");
        builder.AppendLine();
        builder.AppendLine("아래 각 모델의 코드/실행 결과에서 공통으로 맞는 내용과 차이를 요약하세요.");
        builder.AppendLine("출력 형식:");
        builder.AppendLine("[공통]");
        builder.AppendLine("- ...");
        builder.AppendLine("[차이]");
        builder.AppendLine("- ...");
        builder.AppendLine("[추천]");
        builder.AppendLine("- ...");
        builder.AppendLine();
        foreach (var worker in workers)
        {
            builder.AppendLine($"[{worker.Provider}:{worker.Model}]");
            builder.AppendLine(worker.RawResponse.Length > 1800 ? worker.RawResponse[..1800] + "\n...(truncated)" : worker.RawResponse);
            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private static string BuildAutonomousCodingSummary(
        IReadOnlyList<string> iterations,
        IReadOnlyList<string> changedFiles,
        CodeExecutionResult execution,
        int maxIterations
    )
    {
        var highlights = new List<string>();
        foreach (var entry in iterations.TakeLast(12))
        {
            var highlight = ExtractCodingIterationHighlight(entry);
            if (string.IsNullOrWhiteSpace(highlight))
            {
                continue;
            }

            if (highlights.Contains(highlight, StringComparer.Ordinal))
            {
                continue;
            }

            highlights.Add(highlight);
            if (highlights.Count >= 3)
            {
                break;
            }
        }

        if (highlights.Count == 0)
        {
            highlights.Add("반복 로그에서 요약 가능한 핵심 항목이 없습니다.");
        }

        var iterationCount = Math.Min(Math.Max(iterations.Count, 0), Math.Max(maxIterations, 0));
        var builder = new StringBuilder();
        builder.AppendLine($"내부 반복: {iterationCount}/{Math.Max(maxIterations, 1)}");
        builder.AppendLine($"변경 파일: {changedFiles.Count}개");
        builder.AppendLine($"실행 상태: {execution.Status} (exit={execution.ExitCode})");
        if (!string.IsNullOrWhiteSpace(execution.Command) && execution.Command != "(none)" && execution.Command != "-")
        {
            builder.AppendLine($"실행 명령: {TrimForOutput(execution.Command, 180)}");
        }

        builder.AppendLine("핵심 진행:");
        foreach (var highlight in highlights)
        {
            builder.AppendLine($"- {TrimForOutput(highlight, 220)}");
        }

        return builder.ToString().Trim();
    }

    private static string ExtractCodingIterationHighlight(string iterationLog)
    {
        var value = (iterationLog ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        if (value.Contains("plan_parse_failed", StringComparison.OrdinalIgnoreCase))
        {
            return "계획 파싱 실패로 복구 경로를 시도했습니다.";
        }

        if (value.StartsWith("fallback=write:", StringComparison.OrdinalIgnoreCase))
        {
            return "복구 코드 생성 결과를 파일로 저장했습니다.";
        }

        if (value.StartsWith("fallback=scaffold:", StringComparison.OrdinalIgnoreCase))
        {
            return "자동 스캐폴드로 기본 파일을 생성했습니다.";
        }

        if (value.StartsWith("fallback=no_code", StringComparison.OrdinalIgnoreCase))
        {
            return "복구 생성에서도 코드 블록을 찾지 못했습니다.";
        }

        var marker = "analysis=";
        var idx = value.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            var analysis = value[(idx + marker.Length)..];
            var split = analysis.IndexOf(" | ", StringComparison.Ordinal);
            if (split >= 0)
            {
                analysis = analysis[..split];
            }

            analysis = Regex.Replace(analysis, @"\s+", " ").Trim();
            return analysis;
        }

        return Regex.Replace(value, @"\s+", " ").Trim();
    }

    private static string BuildCodingAssistantText(
        string mode,
        string provider,
        string model,
        string language,
        CodeExecutionResult execution,
        IReadOnlyList<string> changedFiles,
        string summary
    )
    {
        var safeCommand = string.IsNullOrWhiteSpace(execution.Command) ? "(none)" : execution.Command;
        var changed = changedFiles.Count == 0
            ? "- 변경 파일 없음"
            : string.Join("\n", changedFiles.Take(6).Select(path => $"- {path}"));
        var hasMoreFiles = changedFiles.Count > 6;
        var compactSummary = TrimForOutput(RemoveCodeBlocksFromText(summary), 800);
        return $"""
                [Coding:{mode}]
                모델: {provider}:{model}
                언어: {language}
                작업 폴더: {execution.RunDirectory}
                실행 상태: {execution.Status} (exit={execution.ExitCode})
                실행 명령: {safeCommand}
                변경 파일: {changedFiles.Count}개
                {changed}
                {(hasMoreFiles ? "- ...(추가 파일 있음, 하단 카드에서 확인)" : string.Empty)}

                요약:
                {compactSummary}

                상세 파일 프리뷰는 아래 '최근 코딩 결과' 카드에서 파일 칩을 눌러 확인하세요.
                """;
    }

    private static string BuildMultiCodingAssistantText(IReadOnlyList<CodingWorkerResult> workers, string summary)
    {
        var builder = new StringBuilder();
        builder.AppendLine("[Coding:multi]");
        builder.AppendLine($"워커 수: {workers.Count}개");
        builder.AppendLine();
        foreach (var worker in workers)
        {
            builder.AppendLine($"- {worker.Provider}:{worker.Model}");
            builder.AppendLine($"  상태={worker.Execution.Status} exit={worker.Execution.ExitCode} 언어={worker.Language} 변경파일={worker.ChangedFiles.Count}개");
            if (!string.IsNullOrWhiteSpace(worker.Execution.Command)
                && worker.Execution.Command != "(none)"
                && worker.Execution.Command != "-")
            {
                builder.AppendLine($"  실행={TrimForOutput(worker.Execution.Command, 180)}");
            }
        }

        builder.AppendLine();
        builder.AppendLine("[요약]");
        builder.AppendLine(TrimForOutput(RemoveCodeBlocksFromText(SanitizeChatOutput(summary)), 2200));
        builder.AppendLine();
        builder.AppendLine("코드 본문은 자동 출력하지 않습니다. 파일 칩을 선택해 프리뷰를 확인하세요.");
        return builder.ToString().Trim();
    }

    private static string RemoveCodeBlocksFromText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var normalized = text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        normalized = Regex.Replace(normalized, "```[\\s\\S]*?```", "[코드 블록 숨김]");
        normalized = Regex.Replace(normalized, @"(?is)\[code\][\s\S]*?(?=\n\[[^\n]+\]|$)", "[code] (숨김)\n");
        normalized = Regex.Replace(normalized, @"(?is)<code[^>]*>[\s\S]*?</code>", "[코드 숨김]");
        normalized = Regex.Replace(normalized, @"\n{3,}", "\n\n");
        return normalized.Trim();
    }

    private async Task<IReadOnlyList<string>> GetAvailableProvidersAsync(CancellationToken cancellationToken)
    {
        return await _providerRegistry.GetAvailableProvidersAsync(cancellationToken);
    }

    private static string NormalizeLanguageForCode(string? language)
    {
        var value = (language ?? string.Empty).Trim().ToLowerInvariant();
        return value switch
        {
            "py" or "python3" => "python",
            "js" or "node" => "javascript",
            "sh" or "shell" => "bash",
            "c++" or "cc" => "cpp",
            "cs" or "c#" => "csharp",
            "kt" => "kotlin",
            "htm" => "html",
            "" or "auto" => "python",
            _ => value
        };
    }

    private static string ResolveInitialCodingLanguage(string? languageHint, string objective)
    {
        var rawHint = (languageHint ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(rawHint) && rawHint != "auto")
        {
            return NormalizeLanguageForCode(rawHint);
        }

        var text = (objective ?? string.Empty).ToLowerInvariant();
        if (ContainsAny(text, "html", "css", "javascript", "js", "ui", "웹", "frontend", "react", "vue", "next", "클론"))
        {
            return "html";
        }

        if (ContainsAny(text, "c#", "dotnet", "asp.net"))
        {
            return "csharp";
        }

        if (ContainsAny(text, "kotlin", "안드로이드"))
        {
            return "kotlin";
        }

        if (ContainsAny(text, "java", "spring"))
        {
            return "java";
        }

        if (ContainsAny(text, "c++", "cpp"))
        {
            return "cpp";
        }

        if (ContainsAny(text, " c ", " gcc ", "clang", "c언어"))
        {
            return "c";
        }

        if (ContainsAny(text, "bash", "shell", "스크립트"))
        {
            return "bash";
        }

        return "python";
    }
}
