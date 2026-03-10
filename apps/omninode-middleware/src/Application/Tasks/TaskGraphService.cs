using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed class TaskGraphService
{
    private static readonly Regex IdRegex = new(
        "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    );

    private readonly FileTaskGraphStore _store;
    private readonly PlanService _planService;
    private readonly object _gate = new();

    public TaskGraphService(FileTaskGraphStore store, PlanService planService)
    {
        _store = store;
        _planService = planService;
    }

    public TaskGraphActionResult CreateGraphFromPlan(string planId)
    {
        var normalizedPlanId = NormalizeId(planId);
        if (normalizedPlanId == null)
        {
            return new TaskGraphActionResult(false, "계획 ID를 입력하세요.", null);
        }

        var snapshot = _planService.GetPlan(normalizedPlanId);
        if (snapshot == null)
        {
            return new TaskGraphActionResult(false, "계획을 찾을 수 없습니다.", null);
        }

        var createdAtUtc = DateTimeOffset.UtcNow;
        var graphId = $"graph_{createdAtUtc:yyyyMMddHHmmssfff}";
        var graph = new TaskGraph(
            graphId,
            snapshot.Plan.PlanId,
            createdAtUtc,
            createdAtUtc,
            TaskGraphStatus.Draft,
            BuildNodes(snapshot.Plan)
        );
        var graphSnapshot = NormalizeSnapshot(new TaskGraphSnapshot(graph, Array.Empty<TaskExecutionRecord>()));

        lock (_gate)
        {
            _store.SaveSnapshot(graphSnapshot);
        }

        return new TaskGraphActionResult(true, "Task graph를 생성했습니다.", graphSnapshot);
    }

    public TaskGraphListResult ListGraphs()
    {
        lock (_gate)
        {
            return new TaskGraphListResult(_store.LoadIndex());
        }
    }

    public TaskGraphSnapshot? GetGraph(string graphId)
    {
        var normalizedGraphId = NormalizeId(graphId);
        if (normalizedGraphId == null)
        {
            return null;
        }

        lock (_gate)
        {
            var snapshot = _store.TryLoadSnapshot(normalizedGraphId);
            if (snapshot == null)
            {
                return null;
            }

            var normalized = NormalizeSnapshot(snapshot);
            _store.SaveSnapshot(normalized);
            return normalized;
        }
    }

    public TaskGraphSnapshot PrepareForRun(string graphId)
    {
        var normalizedGraphId = NormalizeRequiredId(graphId);
        lock (_gate)
        {
            var snapshot = RequireSnapshot(normalizedGraphId);
            var resetNodes = snapshot.Graph.Nodes
                .Select(node => node with
                {
                    Status = TaskNodeStatus.Pending,
                    OutputSummary = null,
                    ArtifactPath = null,
                    Error = null,
                    StartedAtUtc = null,
                    CompletedAtUtc = null
                })
                .ToArray();
            var prepared = NormalizeSnapshot(new TaskGraphSnapshot(
                snapshot.Graph with
                {
                    UpdatedAtUtc = DateTimeOffset.UtcNow,
                    Status = TaskGraphStatus.Running,
                    Nodes = resetNodes
                },
                Array.Empty<TaskExecutionRecord>()
            ));
            _store.SaveSnapshot(prepared);
            return prepared;
        }
    }

    public TaskGraphSnapshot UpdateReadiness(string graphId)
    {
        var normalizedGraphId = NormalizeRequiredId(graphId);
        lock (_gate)
        {
            var snapshot = RequireSnapshot(normalizedGraphId);
            var normalized = NormalizeSnapshot(snapshot);
            _store.SaveSnapshot(normalized);
            return normalized;
        }
    }

    public TaskGraphSnapshot CancelPendingTask(string graphId, string taskId, string? error = null)
    {
        return UpdateTaskState(
            graphId,
            taskId,
            node =>
            {
                if (node.Status == TaskNodeStatus.Completed
                    || node.Status == TaskNodeStatus.Failed
                    || node.Status == TaskNodeStatus.Canceled)
                {
                    return node;
                }

                if (node.Status == TaskNodeStatus.Running)
                {
                    throw new InvalidOperationException("실행 중인 작업은 coordinator를 통해 취소해야 합니다.");
                }

                return node with
                {
                    Status = TaskNodeStatus.Canceled,
                    Error = string.IsNullOrWhiteSpace(error) ? "사용자 요청으로 취소되었습니다." : error.Trim(),
                    CompletedAtUtc = DateTimeOffset.UtcNow
                };
            }
        );
    }

    public TaskGraphSnapshot UpdateTaskState(
        string graphId,
        string taskId,
        Func<TaskNode, TaskNode> taskUpdater,
        Func<IReadOnlyList<TaskExecutionRecord>, IReadOnlyList<TaskExecutionRecord>>? executionUpdater = null
    )
    {
        var normalizedGraphId = NormalizeRequiredId(graphId);
        var normalizedTaskId = NormalizeRequiredId(taskId);
        lock (_gate)
        {
            var snapshot = RequireSnapshot(normalizedGraphId);
            var nodes = snapshot.Graph.Nodes.ToArray();
            var index = Array.FindIndex(
                nodes,
                node => node.TaskId.Equals(normalizedTaskId, StringComparison.Ordinal)
            );
            if (index < 0)
            {
                throw new InvalidOperationException("작업 노드를 찾을 수 없습니다.");
            }

            nodes[index] = taskUpdater(nodes[index]);
            var executions = executionUpdater == null
                ? snapshot.Executions
                : executionUpdater(snapshot.Executions);
            var updated = NormalizeSnapshot(new TaskGraphSnapshot(
                snapshot.Graph with
                {
                    Nodes = nodes
                },
                executions
            ));
            _store.SaveSnapshot(updated);
            return updated;
        }
    }

    public TaskOutputResult? GetTaskOutput(string graphId, string taskId)
    {
        var normalizedGraphId = NormalizeId(graphId);
        var normalizedTaskId = NormalizeId(taskId);
        if (normalizedGraphId == null || normalizedTaskId == null)
        {
            return null;
        }

        lock (_gate)
        {
            var snapshot = _store.TryLoadSnapshot(normalizedGraphId);
            if (snapshot == null)
            {
                return null;
            }

            var execution = snapshot.Executions
                .FirstOrDefault(item =>
                    item.TaskId.Equals(normalizedTaskId, StringComparison.Ordinal));
            return _store.LoadOutput(normalizedGraphId, normalizedTaskId, execution);
        }
    }

    private static TaskGraphSnapshot NormalizeSnapshot(TaskGraphSnapshot snapshot)
    {
        var nodes = snapshot.Graph.Nodes.ToArray();
        var byId = nodes.ToDictionary(node => node.TaskId, StringComparer.Ordinal);

        for (var i = 0; i < nodes.Length; i += 1)
        {
            var node = nodes[i];
            if (node.Status == TaskNodeStatus.Completed
                || node.Status == TaskNodeStatus.Failed
                || node.Status == TaskNodeStatus.Canceled
                || node.Status == TaskNodeStatus.Running)
            {
                continue;
            }

            var dependencies = node.DependsOn
                .Select(depId => byId.TryGetValue(depId, out var dependency) ? dependency : null)
                .Where(dep => dep != null)
                .Cast<TaskNode>()
                .ToArray();

            if (dependencies.Any(dep =>
                dep.Status == TaskNodeStatus.Failed
                || dep.Status == TaskNodeStatus.Canceled))
            {
                nodes[i] = node with
                {
                    Status = TaskNodeStatus.Canceled,
                    Error = string.IsNullOrWhiteSpace(node.Error)
                        ? "선행 작업이 실패 또는 취소되어 실행하지 않았습니다."
                        : node.Error,
                    CompletedAtUtc = node.CompletedAtUtc ?? DateTimeOffset.UtcNow
                };
                continue;
            }

            if (dependencies.All(dep => dep.Status == TaskNodeStatus.Completed))
            {
                if (node.Status == TaskNodeStatus.Blocked)
                {
                    nodes[i] = node with { Status = TaskNodeStatus.Pending };
                }

                continue;
            }

            if (node.Status == TaskNodeStatus.Pending)
            {
                nodes[i] = node with { Status = TaskNodeStatus.Blocked };
            }
        }

        var candidate = snapshot with
        {
            Graph = snapshot.Graph with
            {
                Status = ResolveGraphStatus(snapshot.Graph.Status, nodes),
                Nodes = nodes
            }
        };

        var before = TaskGraphJson.Serialize(snapshot);
        var after = TaskGraphJson.Serialize(candidate);
        if (string.Equals(before, after, StringComparison.Ordinal))
        {
            return snapshot;
        }

        return candidate with
        {
            Graph = candidate.Graph with
            {
                UpdatedAtUtc = DateTimeOffset.UtcNow
            }
        };
    }

    private static TaskGraphStatus ResolveGraphStatus(TaskGraphStatus currentStatus, IReadOnlyList<TaskNode> nodes)
    {
        if (nodes.Count == 0)
        {
            return TaskGraphStatus.Completed;
        }

        if (nodes.Any(node => node.Status == TaskNodeStatus.Running))
        {
            return TaskGraphStatus.Running;
        }

        if (nodes.All(node => node.Status == TaskNodeStatus.Completed))
        {
            return TaskGraphStatus.Completed;
        }

        if (nodes.All(IsTerminalNodeStatus))
        {
            if (nodes.Any(node => node.Status == TaskNodeStatus.Failed))
            {
                return TaskGraphStatus.Failed;
            }

            if (nodes.Any(node => node.Status == TaskNodeStatus.Canceled))
            {
                return TaskGraphStatus.Canceled;
            }
        }

        return currentStatus == TaskGraphStatus.Running
            ? TaskGraphStatus.Running
            : TaskGraphStatus.Draft;
    }

    private static bool IsTerminalNodeStatus(TaskNode node)
    {
        return node.Status == TaskNodeStatus.Completed
            || node.Status == TaskNodeStatus.Failed
            || node.Status == TaskNodeStatus.Canceled;
    }

    private TaskGraphSnapshot RequireSnapshot(string graphId)
    {
        return _store.TryLoadSnapshot(graphId) ?? throw new InvalidOperationException("Task graph를 찾을 수 없습니다.");
    }

    private static string NormalizeRequiredId(string value)
    {
        return NormalizeId(value) ?? throw new InvalidOperationException("ID 형식이 잘못되었습니다.");
    }

    private static string? NormalizeId(string? value)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0 || !IdRegex.IsMatch(normalized))
        {
            return null;
        }

        return normalized;
    }

    private static IReadOnlyList<TaskNode> BuildNodes(WorkPlan plan)
    {
        var nodes = new List<TaskNode>(plan.Steps.Count);
        var pendingAnalysisIds = new List<string>();
        string? lastWorkspaceTaskId = null;
        var allPreviousTaskIds = new List<string>();

        for (var i = 0; i < plan.Steps.Count; i += 1)
        {
            var step = plan.Steps[i];
            var category = ClassifyCategory(step);
            var taskId = $"task-{i + 1:00}";
            var dependsOn = new List<string>();

            if (category == "verification")
            {
                dependsOn.AddRange(allPreviousTaskIds);
            }
            else if (category == "documentation")
            {
                if (!string.IsNullOrWhiteSpace(lastWorkspaceTaskId))
                {
                    dependsOn.Add(lastWorkspaceTaskId);
                }
                else
                {
                    dependsOn.AddRange(pendingAnalysisIds);
                }
            }
            else if (category == "analysis" || category == "research")
            {
                if (!string.IsNullOrWhiteSpace(lastWorkspaceTaskId))
                {
                    dependsOn.Add(lastWorkspaceTaskId);
                }

                pendingAnalysisIds.Add(taskId);
            }
            else
            {
                if (pendingAnalysisIds.Count > 0)
                {
                    dependsOn.AddRange(pendingAnalysisIds);
                    pendingAnalysisIds.Clear();
                }
                else if (!string.IsNullOrWhiteSpace(lastWorkspaceTaskId))
                {
                    dependsOn.Add(lastWorkspaceTaskId);
                }

                lastWorkspaceTaskId = taskId;
            }

            var node = new TaskNode(
                taskId,
                string.IsNullOrWhiteSpace(step.Title) ? step.StepId : step.Title,
                category,
                dependsOn.Count == 0 ? TaskNodeStatus.Pending : TaskNodeStatus.Blocked,
                dependsOn.Distinct(StringComparer.Ordinal).ToArray(),
                BuildNodePrompt(plan, step, category, dependsOn),
                ResolveRequiredSkills(category),
                ResolveRequiredTools(category),
                null,
                null,
                null
            );
            nodes.Add(node);
            allPreviousTaskIds.Add(taskId);
        }

        return nodes;
    }

    private static string BuildNodePrompt(
        WorkPlan plan,
        PlanStep step,
        string category,
        IReadOnlyList<string> dependsOn
    )
    {
        var builder = new StringBuilder();
        builder.AppendLine("다음은 승인된 작업 계획에서 분리한 개별 실행 태스크다.");
        builder.AppendLine();
        builder.AppendLine("[상위 목표]");
        builder.AppendLine(plan.Objective);
        builder.AppendLine();
        builder.AppendLine("[현재 태스크]");
        builder.AppendLine(step.Description);
        builder.AppendLine();
        builder.AppendLine($"[카테고리] {category}");
        if (dependsOn.Count > 0)
        {
            builder.AppendLine($"[선행 태스크] {string.Join(", ", dependsOn)}");
            builder.AppendLine();
        }

        if (step.MustDo.Count > 0)
        {
            builder.AppendLine("[반드시 할 것]");
            foreach (var item in step.MustDo)
            {
                builder.AppendLine($"- {item}");
            }

            builder.AppendLine();
        }

        if (step.MustNotDo.Count > 0)
        {
            builder.AppendLine("[하면 안 되는 것]");
            foreach (var item in step.MustNotDo)
            {
                builder.AppendLine($"- {item}");
            }

            builder.AppendLine();
        }

        if (step.Verification.Count > 0)
        {
            builder.AppendLine("[검증]");
            foreach (var item in step.Verification)
            {
                builder.AppendLine($"- {item}");
            }

            builder.AppendLine();
        }

        builder.AppendLine("[출력 규칙]");
        builder.AppendLine("- 이 태스크 범위 안에서만 작업한다.");
        builder.AppendLine("- 실제로 수행한 변경과 검증만 보고한다.");
        builder.AppendLine("- 실패하면 숨기지 말고 실패 원인을 그대로 남긴다.");
        return builder.ToString().Trim();
    }

    private static string ClassifyCategory(PlanStep step)
    {
        var corpus = string.Join('\n', new[]
        {
            step.Title,
            step.Description,
            string.Join('\n', step.MustDo),
            string.Join('\n', step.MustNotDo),
            string.Join('\n', step.Verification)
        }).ToLowerInvariant();

        if (ContainsAny(corpus, "test", "verify", "verification", "검증", "테스트", "빌드", "lint"))
        {
            return "verification";
        }

        if (ContainsAny(corpus, "doc", "readme", "문서", "문서화", "가이드"))
        {
            return "documentation";
        }

        if (ContainsAny(corpus, "refactor", "리팩토", "구조 정리", "정리"))
        {
            return "refactor";
        }

        if (ContainsAny(corpus, "search", "research", "조사", "자료", "근거", "검색"))
        {
            return "research";
        }

        if (ContainsAny(corpus, "analyze", "analysis", "inspect", "확인", "분석", "파악"))
        {
            return "analysis";
        }

        return "coding";
    }

    private static IReadOnlyList<string> ResolveRequiredSkills(string category)
    {
        return category switch
        {
            "documentation" => new[] { "documentation" },
            "verification" => new[] { "verification" },
            "analysis" => new[] { "analysis" },
            "research" => new[] { "research" },
            "refactor" => new[] { "refactor" },
            _ => new[] { "implementation" }
        };
    }

    private static IReadOnlyList<string> ResolveRequiredTools(string category)
    {
        return category switch
        {
            "research" => new[] { "web_search", "web_fetch" },
            "verification" => new[] { "shell", "workspace_read" },
            "documentation" => new[] { "workspace_edit" },
            "analysis" => new[] { "workspace_read" },
            _ => new[] { "workspace_edit", "shell" }
        };
    }

    private static bool ContainsAny(string text, params string[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (text.Contains(candidate, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
