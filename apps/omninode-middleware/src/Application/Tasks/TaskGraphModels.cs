using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonConverter(typeof(JsonStringEnumConverter<TaskNodeStatus>))]
public enum TaskNodeStatus
{
    Pending,
    Blocked,
    Running,
    Completed,
    Failed,
    Canceled
}

[JsonConverter(typeof(JsonStringEnumConverter<TaskGraphStatus>))]
public enum TaskGraphStatus
{
    Draft,
    Running,
    Completed,
    Failed,
    Canceled
}

public sealed record TaskNode(
    string TaskId,
    string Title,
    string Category,
    TaskNodeStatus Status,
    IReadOnlyList<string> DependsOn,
    string Prompt,
    IReadOnlyList<string> RequiredSkills,
    IReadOnlyList<string> RequiredTools,
    string? OutputSummary,
    string? ArtifactPath,
    string? Error,
    DateTimeOffset? StartedAtUtc = null,
    DateTimeOffset? CompletedAtUtc = null
);

public sealed record TaskGraph(
    string GraphId,
    string SourcePlanId,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    TaskGraphStatus Status,
    IReadOnlyList<TaskNode> Nodes
);

public sealed record TaskGraphSnapshot(
    TaskGraph Graph,
    IReadOnlyList<TaskExecutionRecord> Executions
);

public sealed record TaskGraphActionResult(
    bool Ok,
    string Message,
    TaskGraphSnapshot? Snapshot
);

public sealed record TaskGraphIndexEntry(
    string GraphId,
    string SourcePlanId,
    TaskGraphStatus Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    int TotalNodes,
    int CompletedNodes,
    int FailedNodes,
    int RunningNodes
);

public sealed class TaskGraphIndexState
{
    public TaskGraphIndexEntry[] Items { get; set; } = Array.Empty<TaskGraphIndexEntry>();
}

public sealed record TaskGraphListResult(
    IReadOnlyList<TaskGraphIndexEntry> Items
);

public sealed record TaskOutputResult(
    string GraphId,
    string TaskId,
    TaskExecutionRecord? Execution,
    string StdOut,
    string StdErr,
    string? ResultJson
);

public sealed class TaskGraphEventSink
{
    public Func<string, TaskNode, CancellationToken, Task>? OnTaskUpdatedAsync { get; init; }
    public Func<string, string, string, CancellationToken, Task>? OnTaskLogAsync { get; init; }
}
