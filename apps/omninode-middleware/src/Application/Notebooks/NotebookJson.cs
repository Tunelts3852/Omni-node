using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

internal static class NotebookJson
{
    private static readonly NotebookJsonContext BaseContext = new(CreateOptions(indented: false));
    private static readonly NotebookJsonContext IndentedContext = new(CreateOptions(indented: true));

    public static string Serialize(ProjectNotebookSnapshot snapshot, bool indented = false)
    {
        return JsonSerializer.Serialize(snapshot, (indented ? IndentedContext : BaseContext).ProjectNotebookSnapshot);
    }

    public static string Serialize(NotebookActionResult result, bool indented = false)
    {
        return JsonSerializer.Serialize(result, (indented ? IndentedContext : BaseContext).NotebookActionResult);
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
