using System.Text;
using System.Text.Json;

namespace OmniNode.Middleware;

internal sealed class FileRoutineStore : IRoutineStore
{
    public string StorePath { get; }

    public FileRoutineStore(string storePath)
    {
        StorePath = Path.GetFullPath(storePath);
    }

    public IReadOnlyList<RoutineDefinition> Load()
    {
        if (!File.Exists(StorePath))
        {
            return Array.Empty<RoutineDefinition>();
        }

        var json = File.ReadAllText(StorePath, Encoding.UTF8);
        if (string.IsNullOrWhiteSpace(json))
        {
            return Array.Empty<RoutineDefinition>();
        }

        var state = JsonSerializer.Deserialize(json, OmniJsonContext.Default.RoutineState);
        if (state?.Items == null)
        {
            return Array.Empty<RoutineDefinition>();
        }

        return state.Items
            .Where(item => !string.IsNullOrWhiteSpace(item.Id))
            .ToArray();
    }

    public void Save(IReadOnlyList<RoutineDefinition> items)
    {
        var dir = Path.GetDirectoryName(StorePath);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var state = new RoutineState
        {
            Items = items
                .Where(item => !string.IsNullOrWhiteSpace(item.Id))
                .OrderBy(item => item.CreatedUtc)
                .ToArray()
        };
        var json = JsonSerializer.Serialize(state, OmniJsonContext.Default.RoutineState);
        AtomicFileStore.WriteAllText(StorePath, json, ownerOnly: true);
    }
}
