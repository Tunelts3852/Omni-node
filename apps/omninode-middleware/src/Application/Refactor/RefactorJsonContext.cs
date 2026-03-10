using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(AnchorLine))]
[JsonSerializable(typeof(AnchorReadResult))]
[JsonSerializable(typeof(AnchorEditRequest))]
[JsonSerializable(typeof(AnchorEditRequest[]))]
[JsonSerializable(typeof(AnchorEditIssue))]
[JsonSerializable(typeof(AnchorEditIssue[]))]
[JsonSerializable(typeof(RefactorPreviewFile))]
[JsonSerializable(typeof(RefactorPreviewFile[]))]
[JsonSerializable(typeof(RefactorPreview))]
[JsonSerializable(typeof(RefactorApplyOutcome))]
[JsonSerializable(typeof(RefactorToolInvocationResult))]
[JsonSerializable(typeof(RefactorActionResult))]
[JsonSerializable(typeof(RefactorPreviewRecord))]
internal partial class RefactorJsonContext : JsonSerializerContext
{
}
