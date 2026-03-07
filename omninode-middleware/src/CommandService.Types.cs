using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed record LlmSingleChatResult(string Provider, string Model, string Text);
public sealed record LlmOrchestrationResult(string Route, string Text);
public sealed record LlmMultiChatResult(
    string GroqText,
    string GeminiText,
    string CerebrasText,
    string CopilotText,
    string Summary,
    string GroqModel,
    string GeminiModel,
    string CerebrasModel,
    string CopilotModel,
    string RequestedSummaryProvider,
    string ResolvedSummaryProvider,
    string CodexText = "",
    string CodexModel = ""
);
public sealed record InputAttachment(
    string Name,
    string MimeType,
    string DataBase64,
    long SizeBytes = 0,
    bool IsImage = false
);
public sealed record SearchCitationReference(
    string CitationId,
    string Title,
    string Url,
    string Published,
    string Snippet,
    string SourceType
);
public sealed record SearchCitationSentenceMapping(
    string Segment,
    int SentenceIndex,
    string Sentence,
    IReadOnlyList<string> CitationIds,
    IReadOnlyList<string> UnknownCitationIds,
    bool MissingCitation
);
public sealed record SearchCitationValidationSummary(
    int TotalSentences,
    int TaggedSentences,
    int MissingSentences,
    int UnknownCitationSentences,
    bool Passed
);
public sealed record ChatRequest(
    string Input,
    string Source,
    string Scope,
    string Mode,
    string? ConversationId,
    string? ConversationTitle,
    string? Project,
    string? Category,
    IReadOnlyList<string>? Tags,
    string? Provider,
    string? Model,
    IReadOnlyList<string>? LinkedMemoryNotes,
    string? GroqModel = null,
    string? GeminiModel = null,
    string? CopilotModel = null,
    string? CerebrasModel = null,
    IReadOnlyList<InputAttachment>? Attachments = null,
    IReadOnlyList<string>? WebUrls = null,
    bool WebSearchEnabled = true,
    string? CodexModel = null
);
public sealed record MultiChatRequest(
    string Input,
    string Source,
    string Scope,
    string Mode,
    string? ConversationId,
    string? ConversationTitle,
    string? Project,
    string? Category,
    IReadOnlyList<string>? Tags,
    string? GroqModel,
    string? GeminiModel,
    string? CopilotModel,
    string? CerebrasModel,
    string? SummaryProvider,
    IReadOnlyList<string>? LinkedMemoryNotes,
    IReadOnlyList<InputAttachment>? Attachments = null,
    IReadOnlyList<string>? WebUrls = null,
    bool WebSearchEnabled = true,
    string? CodexModel = null
);
public sealed record ChatStreamUpdate(
    string Scope,
    string Mode,
    string ConversationId,
    string Provider,
    string Model,
    string Route,
    string Delta,
    int ChunkIndex
);
public sealed record ChatLatencyMetrics(
    long DecisionMs,
    long PromptBuildMs,
    long FirstChunkMs,
    long FullResponseMs,
    long SanitizeMs,
    string DecisionPath
);
public sealed record ConversationChatResult(
    string Mode,
    string ConversationId,
    string Provider,
    string Model,
    string Text,
    string Route,
    ConversationThreadView Conversation,
    MemoryNoteSaveResult? AutoMemoryNote,
    SearchAnswerGuardFailure? GuardFailure = null,
    IReadOnlyList<SearchCitationReference>? Citations = null,
    IReadOnlyList<SearchCitationSentenceMapping>? CitationMappings = null,
    SearchCitationValidationSummary? CitationValidation = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-",
    ChatLatencyMetrics? Latency = null
);
public sealed record ConversationMultiResult(
    string ConversationId,
    string GroqText,
    string GeminiText,
    string CerebrasText,
    string CopilotText,
    string Summary,
    string GroqModel,
    string GeminiModel,
    string CerebrasModel,
    string CopilotModel,
    string RequestedSummaryProvider,
    string ResolvedSummaryProvider,
    ConversationThreadView Conversation,
    MemoryNoteSaveResult? AutoMemoryNote,
    SearchAnswerGuardFailure? GuardFailure = null,
    IReadOnlyList<SearchCitationReference>? Citations = null,
    IReadOnlyList<SearchCitationSentenceMapping>? CitationMappings = null,
    SearchCitationValidationSummary? CitationValidation = null,
    string CodexText = "",
    string CodexModel = ""
);
public sealed record CodingRunRequest(
    string Input,
    string Source,
    string Scope,
    string Mode,
    string? ConversationId,
    string? ConversationTitle,
    string? Project,
    string? Category,
    IReadOnlyList<string>? Tags,
    string? Provider,
    string? Model,
    string Language,
    IReadOnlyList<string>? LinkedMemoryNotes,
    string? GroqModel = null,
    string? GeminiModel = null,
    string? CerebrasModel = null,
    string? CopilotModel = null,
    IReadOnlyList<InputAttachment>? Attachments = null,
    IReadOnlyList<string>? WebUrls = null,
    bool WebSearchEnabled = true,
    string? CodexModel = null
);
public sealed record CodingWorkerResult(
    string Provider,
    string Model,
    string Language,
    string Code,
    string RawResponse,
    CodeExecutionResult Execution,
    IReadOnlyList<string> ChangedFiles
);
public sealed record CodingRunResult(
    string Mode,
    string ConversationId,
    string Provider,
    string Model,
    string Language,
    string Code,
    CodeExecutionResult Execution,
    IReadOnlyList<CodingWorkerResult> Workers,
    IReadOnlyList<string> ChangedFiles,
    string Summary,
    ConversationThreadView Conversation,
    MemoryNoteSaveResult? AutoMemoryNote,
    SearchAnswerGuardFailure? GuardFailure = null,
    IReadOnlyList<SearchCitationReference>? Citations = null,
    IReadOnlyList<SearchCitationSentenceMapping>? CitationMappings = null,
    SearchCitationValidationSummary? CitationValidation = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-"
);
public sealed record WorkspaceFilePreview(string FullPath, string Content);
public sealed record CodingProgressUpdate(
    string Mode,
    string Provider,
    string Model,
    string Phase,
    string Message,
    int Iteration,
    int MaxIterations,
    int Percent,
    bool Done
);
internal sealed record ParsedCode(string Language, string Code);
internal sealed record ScaffoldFileSpec(string Path, string Content);
internal sealed record CodingLoopAction(string Type, string Path, string Content, string Command);
internal sealed record CodingLoopPlan(string Analysis, string FinalMessage, bool Done, IReadOnlyList<CodingLoopAction> Actions);
internal sealed record CodingLoopActionResult(string Message, CodeExecutionResult? Execution, string CodePreview, string LastWrittenFile, string ChangedPath, bool Changed);
internal sealed record AutonomousCodingOutcome(string Language, string Code, string RawResponse, CodeExecutionResult Execution, IReadOnlyList<string> ChangedFiles, string Summary);
internal sealed record ShellRunResult(int ExitCode, string StdOut, string StdErr, bool TimedOut);
internal sealed record InputPreparationResult(
    string Text,
    string UnsupportedMessage,
    SearchAnswerGuardFailure? GuardFailure = null,
    IReadOnlyList<SearchCitationReference>? Citations = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-"
);
public sealed record TelegramExecutionMetadata(
    SearchAnswerGuardFailure? GuardFailure = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-"
);
public sealed record RoutineSummary(
    string Id,
    string Title,
    string Request,
    string ExecutionMode,
    string ResolvedExecutionMode,
    string? AgentProvider,
    string? AgentModel,
    string? AgentStartUrl,
    int? AgentTimeoutSeconds,
    bool AgentUsePlaywright,
    string ScheduleText,
    string ScheduleSourceMode,
    int MaxRetries,
    int RetryDelaySeconds,
    string NotifyPolicy,
    bool Enabled,
    string NextRunLocal,
    string LastRunLocal,
    string LastStatus,
    string LastOutput,
    string ScriptPath,
    string Language,
    string CoderModel,
    string ScheduleKind,
    string? ScheduleExpr,
    string TimezoneId,
    string TimeOfDay,
    int? DayOfMonth,
    IReadOnlyList<int> Weekdays,
    IReadOnlyList<RoutineRunSummary> Runs
);
public sealed record RoutineActionResult(bool Ok, string Message, RoutineSummary? Routine);
public sealed record RoutineRunSummary(
    long Ts,
    string RunAtLocal,
    string Status,
    string Source,
    int AttemptCount,
    string Summary,
    string? Error,
    string? TelegramStatus,
    string? ArtifactPath,
    string? AgentSessionId,
    string? AgentRunId,
    string? AgentProvider,
    string? AgentModel,
    string? ToolProfile,
    string? StartUrl,
    string? FinalUrl,
    string? PageTitle,
    string? ScreenshotPath,
    long? DurationMs,
    string DurationText,
    string? NextRunLocal
);
public sealed record RoutineRunDetailResult(
    bool Ok,
    string RoutineId,
    long Ts,
    string Title,
    string Status,
    string Source,
    int AttemptCount,
    string? TelegramStatus,
    string? ArtifactPath,
    string? AgentSessionId,
    string? AgentRunId,
    string? AgentProvider,
    string? AgentModel,
    string? ToolProfile,
    string? StartUrl,
    string? FinalUrl,
    string? PageTitle,
    string? ScreenshotPath,
    string? Error,
    string Content
);
public sealed record CronToolStatusResult(
    bool Enabled,
    string StorePath,
    int Jobs,
    long? NextWakeAtMs
);
public sealed record CronToolSchedule(
    string Kind,
    string? Expr,
    string? Tz,
    string? At,
    long? EveryMs,
    long? AnchorMs
);
public sealed record CronToolPayload(
    string Kind,
    string? Text,
    string? Message,
    string? Model,
    string? Thinking,
    int? TimeoutSeconds,
    bool? LightContext
);
public sealed record CronToolJobState(
    long? NextRunAtMs,
    long? RunningAtMs,
    long? LastRunAtMs,
    string? LastRunStatus,
    string? LastError,
    long? LastDurationMs
);
public sealed record CronToolJob(
    string Id,
    string Name,
    bool Enabled,
    long CreatedAtMs,
    long UpdatedAtMs,
    string SessionTarget,
    string WakeMode,
    CronToolSchedule Schedule,
    CronToolPayload Payload,
    CronToolJobState State,
    string? Description
);
public sealed record CronToolListResult(
    IReadOnlyList<CronToolJob> Jobs,
    int Total,
    int Offset,
    int Limit,
    bool HasMore,
    int? NextOffset
);
public sealed record CronToolAddResult(
    bool Ok,
    CronToolJob? Job,
    string? Error
);
public sealed record CronToolUpdateResult(
    bool Ok,
    CronToolJob? Job,
    string? Error
);
public sealed record CronToolRunResult(
    bool Ok,
    bool Ran,
    string? Reason,
    string? Error
);
public sealed record CronToolRemoveResult(
    bool Ok,
    bool Removed,
    string? Error
);
public sealed record CronToolRunLogEntry(
    long Ts,
    string JobId,
    string Action,
    string? Status,
    string? Source,
    int AttemptCount,
    string? Error,
    string? Summary,
    string? TelegramStatus,
    string? ArtifactPath,
    long? RunAtMs,
    long? DurationMs,
    long? NextRunAtMs,
    string? JobName
);
public sealed record CronToolRunsResult(
    bool Ok,
    IReadOnlyList<CronToolRunLogEntry> Entries,
    int Total,
    int Offset,
    int Limit,
    bool HasMore,
    int? NextOffset,
    string? Error
);
public sealed record CronToolWakeResult(
    bool Ok,
    string Mode,
    int TriggeredRuns,
    string? Error
);
internal sealed record RoutineSchedule(int Hour, int Minute, string Display);
internal sealed record RoutineScheduleConfig(
    string Kind,
    int Hour,
    int Minute,
    string Display,
    string TimezoneId,
    string CronExpr,
    int? DayOfMonth,
    IReadOnlyList<int> Weekdays
);
internal sealed record RoutineModelStrategy(string Mode, IReadOnlyList<string> Models, string Reason);
internal sealed record RoutineGenerationResult(
    string PlannerProvider,
    string PlannerModel,
    string CoderModel,
    string Plan,
    string Language,
    string Code
);
internal sealed class RoutineState
{
    public IReadOnlyList<RoutineDefinition> Items { get; set; } = Array.Empty<RoutineDefinition>();
}
internal sealed class RoutineDefinition
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Request { get; set; } = string.Empty;
    public string ExecutionMode { get; set; } = string.Empty;
    public string? AgentProvider { get; set; }
    public string? AgentModel { get; set; }
    public string? AgentStartUrl { get; set; }
    public int? AgentTimeoutSeconds { get; set; }
    public bool AgentUsePlaywright { get; set; }
    public string ScheduleText { get; set; } = string.Empty;
    public string ScheduleSourceMode { get; set; } = string.Empty;
    public int MaxRetries { get; set; }
    public int RetryDelaySeconds { get; set; } = 15;
    public string NotifyPolicy { get; set; } = "always";
    public string? LastNotifiedFingerprint { get; set; }
    public string TimezoneId { get; set; } = TimeZoneInfo.Local.Id;
    public int Hour { get; set; }
    public int Minute { get; set; }
    public bool Enabled { get; set; } = true;
    public bool Running { get; set; }
    public DateTimeOffset NextRunUtc { get; set; }
    public DateTimeOffset? LastRunUtc { get; set; }
    public string LastStatus { get; set; } = string.Empty;
    public string LastOutput { get; set; } = string.Empty;
    public string ScriptPath { get; set; } = string.Empty;
    public string Language { get; set; } = "bash";
    public string Code { get; set; } = string.Empty;
    public string Planner { get; set; } = string.Empty;
    public string PlannerModel { get; set; } = string.Empty;
    public string CoderModel { get; set; } = string.Empty;
    public bool NotifyTelegram { get; set; }
    public string? CronDescription { get; set; }
    public string CronSessionTarget { get; set; } = "main";
    public string CronWakeMode { get; set; } = "next-heartbeat";
    public string CronPayloadKind { get; set; } = "systemEvent";
    public string? CronPayloadModel { get; set; }
    public string? CronPayloadThinking { get; set; }
    public int? CronPayloadTimeoutSeconds { get; set; }
    public bool? CronPayloadLightContext { get; set; }
    public string CronScheduleKind { get; set; } = "cron";
    public string? CronScheduleExpr { get; set; }
    public long? CronScheduleAtMs { get; set; }
    public long? CronScheduleEveryMs { get; set; }
    public long? CronScheduleAnchorMs { get; set; }
    public long? LastDurationMs { get; set; }
    public List<RoutineRunLogEntry> CronRunLog { get; set; } = new();
    public DateTimeOffset CreatedUtc { get; set; } = DateTimeOffset.UtcNow;
}
internal sealed class RoutineRunLogEntry
{
    public long Ts { get; set; }
    public string JobId { get; set; } = string.Empty;
    public string Action { get; set; } = "finished";
    public string? Status { get; set; }
    public string? Source { get; set; }
    public int AttemptCount { get; set; } = 1;
    public string? Error { get; set; }
    public string? Summary { get; set; }
    public string? TelegramStatus { get; set; }
    public string? ArtifactPath { get; set; }
    public string? AgentSessionId { get; set; }
    public string? AgentRunId { get; set; }
    public string? AgentProvider { get; set; }
    public string? AgentModel { get; set; }
    public string? ToolProfile { get; set; }
    public string? StartUrl { get; set; }
    public string? FinalUrl { get; set; }
    public string? PageTitle { get; set; }
    public string? ScreenshotPath { get; set; }
    public long? RunAtMs { get; set; }
    public long? DurationMs { get; set; }
    public long? NextRunAtMs { get; set; }
}

internal sealed record RoutineAgentExecutionMetadata(
    string? SessionKey,
    string? RunId,
    string? Provider,
    string? Model,
    string? ToolProfile,
    string? StartUrl,
    string? FinalUrl,
    string? PageTitle,
    string? ScreenshotPath
);

internal sealed record RoutineExecutionOutcome(
    string Output,
    string Status,
    string? Error,
    RoutineAgentExecutionMetadata? AgentMetadata = null
);

internal sealed class TelegramLlmPreferences
{
    public string Profile { get; set; } = "default";
    public string Mode { get; set; } = "single";
    public string SingleProvider { get; set; } = "groq";
    public string SingleModel { get; set; } = string.Empty;
    public bool AutoGroqComplexUpgrade { get; set; } = true;
    public string OrchestrationProvider { get; set; } = "auto";
    public string OrchestrationModel { get; set; } = string.Empty;
    public string MultiGroqModel { get; set; } = string.Empty;
    public string MultiCopilotModel { get; set; } = string.Empty;
    public string MultiCerebrasModel { get; set; } = string.Empty;
    public string MultiSummaryProvider { get; set; } = "auto";
    public string TalkThinkingLevel { get; set; } = "low";
    public string CodeThinkingLevel { get; set; } = "high";

        public TelegramLlmPreferences Clone()
        {
        return new TelegramLlmPreferences
        {
            Profile = Profile,
            Mode = Mode,
            SingleProvider = SingleProvider,
            SingleModel = SingleModel,
            AutoGroqComplexUpgrade = AutoGroqComplexUpgrade,
            OrchestrationProvider = OrchestrationProvider,
            OrchestrationModel = OrchestrationModel,
            MultiGroqModel = MultiGroqModel,
            MultiCopilotModel = MultiCopilotModel,
            MultiCerebrasModel = MultiCerebrasModel,
            MultiSummaryProvider = MultiSummaryProvider,
            TalkThinkingLevel = TalkThinkingLevel,
            CodeThinkingLevel = CodeThinkingLevel
            };
        }
}

internal sealed class WebLlmPreferences
{
    public string Profile { get; set; } = "default";
    public string Mode { get; set; } = "single";
    public string SingleProvider { get; set; } = "groq";
    public string SingleModel { get; set; } = string.Empty;
    public bool AutoGroqComplexUpgrade { get; set; } = true;
    public string OrchestrationProvider { get; set; } = "auto";
    public string OrchestrationModel { get; set; } = string.Empty;
    public string MultiGroqModel { get; set; } = string.Empty;
    public string MultiCopilotModel { get; set; } = string.Empty;
    public string MultiCerebrasModel { get; set; } = string.Empty;
    public string MultiSummaryProvider { get; set; } = "auto";
    public string TalkThinkingLevel { get; set; } = "low";
    public string CodeThinkingLevel { get; set; } = "high";

    public WebLlmPreferences Clone()
    {
        return new WebLlmPreferences
        {
            Profile = Profile,
            Mode = Mode,
            SingleProvider = SingleProvider,
            SingleModel = SingleModel,
            AutoGroqComplexUpgrade = AutoGroqComplexUpgrade,
            OrchestrationProvider = OrchestrationProvider,
            OrchestrationModel = OrchestrationModel,
            MultiGroqModel = MultiGroqModel,
            MultiCopilotModel = MultiCopilotModel,
            MultiCerebrasModel = MultiCerebrasModel,
            MultiSummaryProvider = MultiSummaryProvider,
            TalkThinkingLevel = TalkThinkingLevel,
            CodeThinkingLevel = CodeThinkingLevel
        };
    }
}

internal sealed record NaturalCommandInterpretation(
    string Kind,
    string Command,
    IReadOnlyDictionary<string, string> Args,
    double Confidence,
    string Reason
);

internal sealed record CanonicalCommand(
    string Key,
    string SlashCommand
);

internal sealed record NaturalCommandValidationResult(
    bool Valid,
    bool IsChat,
    CanonicalCommand? Canonical,
    string Code,
    string Message
);
