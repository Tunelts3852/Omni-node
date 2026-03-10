using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

internal static class FileTelegramReplyOutboxJson
{
    private static readonly TelegramReplyOutboxJsonContext BaseContext = new(CreateOptions(indented: false));
    private static readonly TelegramReplyOutboxJsonContext IndentedContext = new(CreateOptions(indented: true));

    public static string SerializeState(TelegramReplyOutboxState state, bool indented = true)
    {
        return JsonSerializer.Serialize(state, (indented ? IndentedContext : BaseContext).TelegramReplyOutboxState);
    }

    public static TelegramReplyOutboxState? DeserializeState(string json)
    {
        return JsonSerializer.Deserialize(json, BaseContext.TelegramReplyOutboxState);
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
