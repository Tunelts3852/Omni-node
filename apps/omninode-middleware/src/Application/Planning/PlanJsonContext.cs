using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(WorkPlan))]
[JsonSerializable(typeof(PlanReviewResult))]
[JsonSerializable(typeof(PlanExecutionRecord))]
[JsonSerializable(typeof(PlanSnapshot))]
[JsonSerializable(typeof(PlanActionResult))]
[JsonSerializable(typeof(PlanIndexEntry))]
[JsonSerializable(typeof(PlanIndexState))]
[JsonSerializable(typeof(PlanListResult))]
internal partial class PlanJsonContext : JsonSerializerContext
{
}
