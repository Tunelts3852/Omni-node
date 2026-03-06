using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(CopilotState))]
[JsonSerializable(typeof(LlmUsageState))]
[JsonSerializable(typeof(ConversationState))]
[JsonSerializable(typeof(AuthSessionState))]
[JsonSerializable(typeof(RoutineState))]
internal partial class OmniJsonContext : JsonSerializerContext
{
}
