using System.Text;

namespace OmniNode.Middleware;

public sealed class CommandTemplateLoader
{
    private readonly IStatePathResolver _pathResolver;

    public CommandTemplateLoader(IStatePathResolver pathResolver)
    {
        _pathResolver = pathResolver;
    }

    public IReadOnlyList<CommandTemplateInfo> Load(string projectRoot)
    {
        var items = new List<CommandTemplateInfo>();
        LoadDirectory(Path.Combine(projectRoot, ".omni", "commands"), "project");
        LoadDirectory(_pathResolver.GetGlobalCommandsRoot(), "global");
        return items
            .OrderBy(item => item.Scope, StringComparer.Ordinal)
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        void LoadDirectory(string root, string scope)
        {
            if (!Directory.Exists(root))
            {
                return;
            }

            foreach (var path in Directory.GetFiles(root, "*.md", SearchOption.TopDirectoryOnly))
            {
                var template = ParseCommandTemplate(path, scope);
                if (template != null)
                {
                    items.Add(template);
                }
            }
        }
    }

    private static CommandTemplateInfo? ParseCommandTemplate(string path, string scope)
    {
        string[] lines;
        try
        {
            lines = File.ReadAllLines(path, Encoding.UTF8);
        }
        catch
        {
            return null;
        }

        var name = Path.GetFileNameWithoutExtension(path);
        var summary = string.Empty;
        foreach (var rawLine in lines.Take(40))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line == "---")
            {
                continue;
            }

            if (line.StartsWith("#", StringComparison.Ordinal))
            {
                name = line.TrimStart('#', ' ');
                continue;
            }

            if (summary.Length == 0)
            {
                summary = line;
            }
        }

        if (summary.Length == 0)
        {
            summary = "요약이 없습니다.";
        }

        return new CommandTemplateInfo(name, summary, path, scope);
    }
}
