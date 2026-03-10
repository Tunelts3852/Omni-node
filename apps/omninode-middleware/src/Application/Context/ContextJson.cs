using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

internal static class ContextJson
{
    private static readonly ContextJsonContext BaseContext = new(CreateOptions(indented: false));
    private static readonly ContextJsonContext IndentedContext = new(CreateOptions(indented: true));

    public static string Serialize(ProjectContextSnapshot snapshot, bool indented = false)
    {
        return JsonSerializer.Serialize(snapshot, (indented ? IndentedContext : BaseContext).ProjectContextSnapshot);
    }

    public static string Serialize(SkillManifestListResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).SkillManifestListResult);
    }

    public static string Serialize(CommandTemplateListResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).CommandTemplateListResult);
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
