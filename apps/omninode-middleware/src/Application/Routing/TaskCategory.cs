using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonConverter(typeof(JsonStringEnumConverter<TaskCategory>))]
public enum TaskCategory
{
    GeneralChat,
    Planner,
    Reviewer,
    SearchTimeSensitive,
    SearchFallback,
    DeepCode,
    SafeRefactor,
    QuickFix,
    VisualUi,
    RoutineBuilder,
    BackgroundMonitor,
    Documentation
}

internal static class TaskCategoryMetadata
{
    internal static readonly TaskCategory[] All = Enum
        .GetValues<TaskCategory>()
        .ToArray();

    internal static string ToPolicyKey(TaskCategory category)
    {
        return category switch
        {
            TaskCategory.GeneralChat => "generalChat",
            TaskCategory.Planner => "planner",
            TaskCategory.Reviewer => "reviewer",
            TaskCategory.SearchTimeSensitive => "searchTimeSensitive",
            TaskCategory.SearchFallback => "searchFallback",
            TaskCategory.DeepCode => "deepCode",
            TaskCategory.SafeRefactor => "safeRefactor",
            TaskCategory.QuickFix => "quickFix",
            TaskCategory.VisualUi => "visualUi",
            TaskCategory.RoutineBuilder => "routineBuilder",
            TaskCategory.BackgroundMonitor => "backgroundMonitor",
            TaskCategory.Documentation => "documentation",
            _ => "generalChat"
        };
    }

    internal static string ToDisplayLabel(TaskCategory category)
    {
        return category switch
        {
            TaskCategory.GeneralChat => "일반 채팅",
            TaskCategory.Planner => "계획 생성",
            TaskCategory.Reviewer => "계획 리뷰",
            TaskCategory.SearchTimeSensitive => "최신성 검색",
            TaskCategory.SearchFallback => "검색 보조",
            TaskCategory.DeepCode => "깊은 코딩",
            TaskCategory.SafeRefactor => "안전 리팩터",
            TaskCategory.QuickFix => "빠른 수정",
            TaskCategory.VisualUi => "UI 작업",
            TaskCategory.RoutineBuilder => "루틴 빌더",
            TaskCategory.BackgroundMonitor => "백그라운드 모니터",
            TaskCategory.Documentation => "문서화",
            _ => "일반 채팅"
        };
    }

    internal static TaskCategory? Parse(string? value)
    {
        var normalized = NormalizeKey(value);
        if (normalized.Length == 0)
        {
            return null;
        }

        foreach (var category in All)
        {
            if (NormalizeKey(ToPolicyKey(category)) == normalized)
            {
                return category;
            }
        }

        return null;
    }

    internal static string NormalizeKey(string? value)
    {
        var raw = (value ?? string.Empty).Trim();
        if (raw.Length == 0)
        {
            return string.Empty;
        }

        var builder = new System.Text.StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            if (char.IsLetterOrDigit(ch))
            {
                builder.Append(char.ToLowerInvariant(ch));
            }
        }

        return builder.ToString();
    }
}
