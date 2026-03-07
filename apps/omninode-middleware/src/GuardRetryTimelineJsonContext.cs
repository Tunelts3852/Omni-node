using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(
    WriteIndented = false,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase
)]
[JsonSerializable(typeof(GuardRetryTimelineStore.GuardRetryTimelinePersistedState))]
[JsonSerializable(typeof(GuardRetryTimelineStore.GuardRetryTimelineSnapshot))]
internal partial class GuardRetryTimelineJsonContext : JsonSerializerContext
{
}
