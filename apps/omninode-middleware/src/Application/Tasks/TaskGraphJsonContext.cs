using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(TaskNode))]
[JsonSerializable(typeof(TaskGraph))]
[JsonSerializable(typeof(TaskExecutionRecord))]
[JsonSerializable(typeof(TaskGraphSnapshot))]
[JsonSerializable(typeof(TaskGraphActionResult))]
[JsonSerializable(typeof(TaskGraphIndexEntry))]
[JsonSerializable(typeof(TaskGraphIndexState))]
[JsonSerializable(typeof(TaskGraphListResult))]
[JsonSerializable(typeof(TaskOutputResult))]
internal partial class TaskGraphJsonContext : JsonSerializerContext
{
}
