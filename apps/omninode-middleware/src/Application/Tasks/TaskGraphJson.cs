using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

internal static class TaskGraphJson
{
    private static readonly TaskGraphJsonContext BaseContext = new(CreateOptions(indented: false));
    private static readonly TaskGraphJsonContext IndentedContext = new(CreateOptions(indented: true));

    public static string Serialize(TaskNode node, bool indented = false)
    {
        return JsonSerializer.Serialize(node, (indented ? IndentedContext : BaseContext).TaskNode);
    }

    public static string Serialize(TaskGraph graph, bool indented = false)
    {
        return JsonSerializer.Serialize(graph, (indented ? IndentedContext : BaseContext).TaskGraph);
    }

    public static string Serialize(TaskExecutionRecord execution, bool indented = false)
    {
        return JsonSerializer.Serialize(execution, (indented ? IndentedContext : BaseContext).TaskExecutionRecord);
    }

    public static string Serialize(TaskGraphSnapshot snapshot, bool indented = false)
    {
        return JsonSerializer.Serialize(snapshot, (indented ? IndentedContext : BaseContext).TaskGraphSnapshot);
    }

    public static string Serialize(TaskGraphActionResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).TaskGraphActionResult);
    }

    public static string Serialize(TaskGraphListResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).TaskGraphListResult);
    }

    public static string Serialize(TaskGraphIndexState state, bool indented = false)
    {
        return JsonSerializer.Serialize(state, (indented ? IndentedContext : BaseContext).TaskGraphIndexState);
    }

    public static string Serialize(TaskOutputResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).TaskOutputResult);
    }

    public static TaskGraphSnapshot? DeserializeSnapshot(string json)
    {
        return JsonSerializer.Deserialize(json, BaseContext.TaskGraphSnapshot);
    }

    public static TaskGraphIndexState? DeserializeIndexState(string json)
    {
        return JsonSerializer.Deserialize(json, BaseContext.TaskGraphIndexState);
    }

    private static JsonSerializerOptions CreateOptions(bool indented)
    {
        return new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            WriteIndented = indented,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };
    }
}
