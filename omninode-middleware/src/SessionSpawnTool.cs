namespace OmniNode.Middleware;

public sealed record SessionSpawnToolResult(
    string Status,
    string? Error,
    string RunId,
    string ChildSessionKey,
    string Mode,
    string Runtime,
    string? Note,
    int RunTimeoutSeconds,
    bool Thread,
    bool TaskTruncated,
    string FollowUpStatus,
    string FollowUpAction,
    string? BackendSessionId = null,
    string? ThreadBindingKey = null
);

public sealed class SessionSpawnTool
{
    private const int SessionsSpawnTaskMaxChars = 4000;
    private const int SessionsSpawnLabelMaxChars = 80;
    private const int SessionsSpawnMaxTimeoutSeconds = 86_400;
    private const string SpawnAcceptedNote =
        "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message.";
    private const string SpawnSessionAcceptedNote =
        "thread-bound session stays active after this task; continue in-thread for follow-ups.";
    private const string AcpSpawnAcceptedNote =
        "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
    private const string AcpSpawnSessionAcceptedNote =
        "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";
    private const string AcpPlaceholderReply =
        "ACP runtime bridge accepted this session and started dispatch preparation.";
    private const string AcpDispatchStartedReply =
        "ACP runtime bridge dispatched the initial task to the session runtime lane.";
    private const string AcpRunAnnounceReply =
        "ACP run completed in bridge mode. Review this child session transcript for result handoff.";
    private const string AcpSessionActiveReply =
        "ACP persistent session is active. Continue follow-ups in this bound thread.";

    private readonly ConversationStore _conversationStore;
    private readonly AcpSessionBindingAdapter _acpSessionBindingAdapter;

    public SessionSpawnTool(
        ConversationStore conversationStore,
        AcpSessionBindingAdapter acpSessionBindingAdapter
    )
    {
        _conversationStore = conversationStore;
        _acpSessionBindingAdapter = acpSessionBindingAdapter;
    }

    public SessionSpawnToolResult Spawn(
        string? task,
        string? label = null,
        string? runtime = null,
        int? runTimeoutSeconds = null,
        int? timeoutSeconds = null,
        bool? thread = null,
        string? mode = null,
        string? acpModel = null,
        string? acpThinking = null,
        bool? acpLightContext = null
    )
    {
        var runId = Guid.NewGuid().ToString("N");
        var normalizedRuntime = NormalizeRuntime(runtime);
        var threadRequested = thread == true;
        var resolvedMode = ResolveMode(mode, threadRequested);
        var resolvedTimeoutSeconds = ResolveRunTimeoutSeconds(runTimeoutSeconds, timeoutSeconds);

        var normalizedTask = (task ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedTask))
        {
            return ErrorResult(
                "task is required",
                runId,
                normalizedRuntime,
                resolvedMode,
                resolvedTimeoutSeconds,
                threadRequested
            );
        }

        if (resolvedMode == "session" && !threadRequested)
        {
            return ErrorResult(
                "mode=session requires thread=true.",
                runId,
                normalizedRuntime,
                resolvedMode,
                resolvedTimeoutSeconds,
                threadRequested
            );
        }

        var taskTruncated = false;
        if (normalizedTask.Length > SessionsSpawnTaskMaxChars)
        {
            normalizedTask = normalizedTask[..SessionsSpawnTaskMaxChars] + "\n...(truncated)...";
            taskTruncated = true;
        }

        var normalizedLabel = NormalizeLabel(label);
        if (normalizedRuntime == "acp")
        {
            return SpawnAcpSession(
                runId,
                normalizedTask,
                normalizedLabel,
                resolvedMode,
                resolvedTimeoutSeconds,
                threadRequested,
                taskTruncated,
                acpModel,
                acpThinking,
                acpLightContext
            );
        }

        return SpawnSubagentSession(
            runId,
            normalizedTask,
            normalizedLabel,
            normalizedRuntime,
            resolvedMode,
            resolvedTimeoutSeconds,
            threadRequested,
            taskTruncated
        );
    }

    private SessionSpawnToolResult SpawnSubagentSession(
        string runId,
        string task,
        string? label,
        string runtime,
        string mode,
        int runTimeoutSeconds,
        bool thread,
        bool taskTruncated
    )
    {
        var created = _conversationStore.Create(
            scope: "chat",
            mode: "single",
            title: string.IsNullOrWhiteSpace(label)
                ? $"spawn-{runtime}-{mode}-{DateTimeOffset.UtcNow:MMdd-HHmm}"
                : label,
            project: "subagent",
            category: mode,
            tags: new[] { "sessions_spawn", runtime, mode }
        );
        _ = _conversationStore.AppendMessage(
            created.Id,
            "user",
            task,
            "sessions_spawn"
        );

        var note = mode == "session"
            ? SpawnSessionAcceptedNote
            : SpawnAcceptedNote;
        return new SessionSpawnToolResult(
            "accepted",
            null,
            runId,
            created.Id,
            mode,
            runtime,
            note,
            runTimeoutSeconds,
            thread,
            taskTruncated,
            mode == "session" ? "session_active" : "pending_completion",
            mode == "session" ? "continue_in_thread" : "announce_on_completion"
        );
    }

    private SessionSpawnToolResult SpawnAcpSession(
        string runId,
        string task,
        string? label,
        string mode,
        int runTimeoutSeconds,
        bool thread,
        bool taskTruncated,
        string? acpModel,
        string? acpThinking,
        bool? acpLightContext
    )
    {
        AcpSessionBindingDispatchResult? dispatchResultSnapshot = null;
        var created = _conversationStore.Create(
            scope: "chat",
            mode: "single",
            title: string.IsNullOrWhiteSpace(label)
                ? $"spawn-acp-{mode}-{DateTimeOffset.UtcNow:MMdd-HHmm}"
                : label,
            project: "acp",
            category: mode,
            tags: new[] { "sessions_spawn", "acp", mode, "staged" }
        );
        _ = _conversationStore.AppendMessage(
            created.Id,
            "user",
            task,
            "sessions_spawn"
        );
        _ = _conversationStore.AppendMessage(
            created.Id,
            "assistant",
            AcpPlaceholderReply,
            "sessions_spawn_acp_staged"
        );
        _ = _conversationStore.UpdateMetadata(
            created.Id,
            project: null,
            category: null,
            tags: new[] { "sessions_spawn", "acp", mode, "staged" }
        );

        try
        {
            _ = _conversationStore.AppendMessage(
                created.Id,
                "system",
                $"acp.lifecycle runId={runId} state=dispatched mode={mode}",
                "sessions_spawn_acp_dispatched"
            );
            _ = _conversationStore.AppendMessage(
                created.Id,
                "assistant",
                AcpDispatchStartedReply,
                "sessions_spawn_acp_dispatched"
            );
            _ = _conversationStore.UpdateMetadata(
                created.Id,
                project: null,
                category: null,
                tags: new[] { "sessions_spawn", "acp", mode, "dispatching" }
            );
            var dispatchResult = _acpSessionBindingAdapter.Dispatch(
                new AcpSessionBindingDispatchRequest(
                    runId,
                    created.Id,
                    mode,
                    task,
                    runTimeoutSeconds,
                    thread,
                    acpModel,
                    acpThinking,
                    acpLightContext
                )
            );
            dispatchResultSnapshot = dispatchResult;
            _ = _conversationStore.AppendMessage(
                created.Id,
                "system",
                BuildAcpDispatchTraceLine(runId, dispatchResult, acpModel, acpThinking, acpLightContext),
                "sessions_spawn_acp_dispatch"
            );
            if (!dispatchResult.Accepted)
            {
                var errorText = NormalizeSingleLine(dispatchResult.Error);
                if (string.IsNullOrWhiteSpace(errorText))
                {
                    errorText = NormalizeSingleLine(dispatchResult.Message);
                }

                throw new InvalidOperationException(errorText ?? "acp adapter rejected dispatch");
            }

            if (mode == "session")
            {
                _ = _conversationStore.AppendMessage(
                    created.Id,
                    "assistant",
                    AcpSessionActiveReply,
                    "sessions_spawn_acp_session_active"
                );
                _ = _conversationStore.AppendMessage(
                    created.Id,
                    "system",
                    $"acp.lifecycle runId={runId} state=session_active mode={mode}",
                    "sessions_spawn_acp_lifecycle"
                );
                _ = _conversationStore.UpdateMetadata(
                    created.Id,
                    project: null,
                    category: null,
                    tags: new[] { "sessions_spawn", "acp", mode, "active" }
                );
                return new SessionSpawnToolResult(
                    "accepted",
                    null,
                    runId,
                    created.Id,
                    mode,
                    "acp",
                    AcpSpawnSessionAcceptedNote,
                    runTimeoutSeconds,
                    thread,
                    taskTruncated,
                    "session_active",
                    "continue_in_thread",
                    dispatchResult.BackendSessionId,
                    dispatchResult.ThreadBindingKey
                );
            }

            _ = _conversationStore.AppendMessage(
                created.Id,
                "assistant",
                AcpRunAnnounceReply,
                "sessions_spawn_acp_announced"
            );
            _ = _conversationStore.AppendMessage(
                created.Id,
                "system",
                $"acp.lifecycle runId={runId} state=completed mode={mode}",
                "sessions_spawn_acp_lifecycle"
            );
            _ = _conversationStore.UpdateMetadata(
                created.Id,
                project: null,
                category: null,
                tags: new[] { "sessions_spawn", "acp", mode, "completed" }
            );
            return new SessionSpawnToolResult(
                "accepted",
                null,
                runId,
                created.Id,
                mode,
                "acp",
                AcpSpawnAcceptedNote,
                runTimeoutSeconds,
                thread,
                taskTruncated,
                "completion_announced",
                "review_child_session",
                dispatchResult.BackendSessionId,
                dispatchResult.ThreadBindingKey
            );
        }
        catch (Exception ex)
        {
            _ = _conversationStore.AppendMessage(
                created.Id,
                "assistant",
                $"ACP runtime bridge dispatch failed: {ex.Message}",
                "sessions_spawn_acp_failed"
            );
            _ = _conversationStore.UpdateMetadata(
                created.Id,
                project: null,
                category: null,
                tags: new[] { "sessions_spawn", "acp", mode, "failed" }
            );
            return new SessionSpawnToolResult(
                "error",
                $"acp runtime dispatch failed: {ex.Message}",
                runId,
                created.Id,
                mode,
                "acp",
                null,
                runTimeoutSeconds,
                thread,
                taskTruncated,
                "failed",
                "inspect_error",
                dispatchResultSnapshot?.BackendSessionId,
                dispatchResultSnapshot?.ThreadBindingKey
            );
        }
    }

    private static SessionSpawnToolResult ErrorResult(
        string error,
        string runId,
        string runtime,
        string mode,
        int runTimeoutSeconds,
        bool thread
    )
    {
        return new SessionSpawnToolResult(
            "error",
            error,
            runId,
            string.Empty,
            mode,
            runtime,
            null,
            runTimeoutSeconds,
            thread,
            false,
            "none",
            "fix_request"
        );
    }

    private static string NormalizeRuntime(string? runtime)
    {
        var normalized = (runtime ?? string.Empty).Trim().ToLowerInvariant();
        return normalized == "acp" ? "acp" : "subagent";
    }

    private static string ResolveMode(string? mode, bool threadRequested)
    {
        var normalized = (mode ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized is "run" or "session")
        {
            return normalized;
        }

        return threadRequested ? "session" : "run";
    }

    private static int ResolveRunTimeoutSeconds(int? runTimeoutSeconds, int? timeoutSeconds)
    {
        var candidate = runTimeoutSeconds ?? timeoutSeconds ?? 0;
        return Math.Clamp(candidate, 0, SessionsSpawnMaxTimeoutSeconds);
    }

    private static string? NormalizeLabel(string? label)
    {
        if (string.IsNullOrWhiteSpace(label))
        {
            return null;
        }

        var normalized = label
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
        if (normalized.Length <= SessionsSpawnLabelMaxChars)
        {
            return normalized;
        }

        return normalized[..SessionsSpawnLabelMaxChars].TrimEnd();
    }

    private static string BuildAcpDispatchTraceLine(
        string runId,
        AcpSessionBindingDispatchResult dispatchResult,
        string? acpModel,
        string? acpThinking,
        bool? acpLightContext
    )
    {
        var lines = new List<string>
        {
            $"acp.dispatch runId={runId} status={dispatchResult.Status} backend={NormalizeSingleLine(dispatchResult.Backend) ?? "unknown"} mode={NormalizeSingleLine(dispatchResult.DispatchMode) ?? "unknown"}"
        };

        if (!string.IsNullOrWhiteSpace(dispatchResult.BackendSessionId))
        {
            lines.Add($"acp.dispatch.backendSessionId={NormalizeSingleLine(dispatchResult.BackendSessionId)}");
        }

        if (!string.IsNullOrWhiteSpace(dispatchResult.ThreadBindingKey))
        {
            lines.Add($"acp.dispatch.threadBindingKey={NormalizeSingleLine(dispatchResult.ThreadBindingKey)}");
        }

        if (!string.IsNullOrWhiteSpace(acpModel))
        {
            lines.Add($"acp.option.model={NormalizeSingleLine(acpModel)}");
        }

        if (!string.IsNullOrWhiteSpace(acpThinking))
        {
            lines.Add($"acp.option.thinking={NormalizeSingleLine(acpThinking)}");
        }

        if (acpLightContext.HasValue)
        {
            lines.Add($"acp.option.lightContext={(acpLightContext.Value ? "true" : "false")}");
        }

        if (!string.IsNullOrWhiteSpace(dispatchResult.Message))
        {
            lines.Add($"acp.dispatch.message={NormalizeSingleLine(dispatchResult.Message)}");
        }

        if (!string.IsNullOrWhiteSpace(dispatchResult.Error))
        {
            lines.Add($"acp.dispatch.error={NormalizeSingleLine(dispatchResult.Error)}");
        }

        return string.Join("\n", lines);
    }

    private static string? NormalizeSingleLine(string? value)
    {
        var normalized = (value ?? string.Empty)
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        if (normalized.Length <= 240)
        {
            return normalized;
        }

        return normalized[..240].TrimEnd() + "...";
    }
}
