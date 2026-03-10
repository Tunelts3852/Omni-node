using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

internal static class DoctorJson
{
    private static readonly DoctorJsonContext BaseContext = new(CreateOptions(indented: false));
    private static readonly DoctorJsonContext IndentedContext = new(CreateOptions(indented: true));

    public static string Serialize(DoctorReport report, bool indented = false)
    {
        return JsonSerializer.Serialize(report, (indented ? IndentedContext : BaseContext).DoctorReport);
    }

    public static DoctorReport? DeserializeReport(string json)
    {
        return JsonSerializer.Deserialize(json, BaseContext.DoctorReport);
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
