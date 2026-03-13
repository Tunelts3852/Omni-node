using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(LogicViewport))]
[JsonSerializable(typeof(LogicNodePosition))]
[JsonSerializable(typeof(LogicGraphSchedule))]
[JsonSerializable(typeof(LogicEdgeCondition))]
[JsonSerializable(typeof(LogicNodeDefinition))]
[JsonSerializable(typeof(LogicEdgeDefinition))]
[JsonSerializable(typeof(LogicGraphDefinition))]
[JsonSerializable(typeof(LogicGraphSummary))]
[JsonSerializable(typeof(LogicGraphSummary[]), TypeInfoPropertyName = "LogicGraphSummaryArray")]
[JsonSerializable(typeof(LogicPathBrowseRoot))]
[JsonSerializable(typeof(LogicPathBrowseRoot[]), TypeInfoPropertyName = "LogicPathBrowseRootArray")]
[JsonSerializable(typeof(LogicPathBrowseEntry))]
[JsonSerializable(typeof(LogicPathBrowseEntry[]), TypeInfoPropertyName = "LogicPathBrowseEntryArray")]
[JsonSerializable(typeof(LogicNodeResultEnvelope))]
[JsonSerializable(typeof(LogicNodeRunState))]
[JsonSerializable(typeof(LogicRunSnapshot))]
internal partial class LogicGraphJsonContext : JsonSerializerContext
{
}
