using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(InstructionSource))]
[JsonSerializable(typeof(InstructionBundle))]
[JsonSerializable(typeof(SkillManifest))]
[JsonSerializable(typeof(CommandTemplateInfo))]
[JsonSerializable(typeof(ProjectContextSnapshot))]
[JsonSerializable(typeof(SkillManifestListResult))]
[JsonSerializable(typeof(CommandTemplateListResult))]
internal partial class ContextJsonContext : JsonSerializerContext
{
}
