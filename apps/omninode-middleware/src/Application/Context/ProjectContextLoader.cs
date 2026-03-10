using System.Text;

namespace OmniNode.Middleware;

public sealed class ProjectContextLoader
{
    private readonly AgentInstructionLoader _instructionLoader;
    private readonly SkillManifestLoader _skillLoader;
    private readonly CommandTemplateLoader _commandLoader;

    public ProjectContextLoader(
        AgentInstructionLoader instructionLoader,
        SkillManifestLoader skillLoader,
        CommandTemplateLoader commandLoader
    )
    {
        _instructionLoader = instructionLoader;
        _skillLoader = skillLoader;
        _commandLoader = commandLoader;
    }

    public ProjectContextSnapshot LoadSnapshot(string? currentDirectory = null)
    {
        var cwd = Path.GetFullPath(currentDirectory ?? Directory.GetCurrentDirectory());
        var projectRoot = ResolveProjectRoot(cwd);
        var instructions = _instructionLoader.Load(projectRoot, cwd);
        var skills = _skillLoader.Load(projectRoot);
        var commands = _commandLoader.Load(projectRoot);
        return new ProjectContextSnapshot(
            projectRoot,
            cwd,
            instructions,
            skills,
            commands,
            DateTimeOffset.UtcNow.ToString("O")
        );
    }

    public string BuildPromptContext(ProjectContextSnapshot snapshot, int maxChars = 2400)
    {
        var builder = new StringBuilder();
        builder.AppendLine("project_root:");
        builder.AppendLine(snapshot.ProjectRoot);
        builder.AppendLine("current_directory:");
        builder.AppendLine(snapshot.CurrentDirectory);

        if (snapshot.Instructions.Sources.Count > 0)
        {
            builder.AppendLine("instruction_sources:");
            foreach (var source in snapshot.Instructions.Sources.Take(8))
            {
                builder.AppendLine($"- {source.Scope} :: {source.Path}");
            }
        }

        if (!string.IsNullOrWhiteSpace(snapshot.Instructions.CombinedText))
        {
            builder.AppendLine("instructions:");
            builder.AppendLine(TrimBlock(snapshot.Instructions.CombinedText, Math.Max(800, maxChars / 2)));
        }

        if (snapshot.Skills.Count > 0)
        {
            builder.AppendLine("skills:");
            foreach (var skill in snapshot.Skills.Take(12))
            {
                builder.AppendLine($"- {skill.Name}: {TrimBlock(skill.Description, 120)}");
            }
        }

        if (snapshot.Commands.Count > 0)
        {
            builder.AppendLine("commands:");
            foreach (var command in snapshot.Commands.Take(12))
            {
                builder.AppendLine($"- {command.Name}: {TrimBlock(command.Summary, 120)}");
            }
        }

        return TrimBlock(builder.ToString().Trim(), maxChars);
    }

    private static string ResolveProjectRoot(string cwd)
    {
        return FindAncestor(cwd, path =>
            Directory.Exists(Path.Combine(path, ".git"))
            || File.Exists(Path.Combine(path, ".git"))
        )
        ?? FindAncestor(cwd, path =>
            Directory.Exists(Path.Combine(path, ".omni"))
            || File.Exists(Path.Combine(path, "AGENTS.md"))
            || File.Exists(Path.Combine(path, "AGENTS.override.md"))
        )
        ?? cwd;
    }

    private static string? FindAncestor(string startPath, Func<string, bool> predicate)
    {
        var current = Path.GetFullPath(startPath);
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (predicate(current))
            {
                return current;
            }

            var parent = Directory.GetParent(current);
            if (parent == null)
            {
                return null;
            }

            current = parent.FullName;
        }

        return null;
    }

    private static string TrimBlock(string text, int maxChars)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length <= maxChars)
        {
            return normalized;
        }

        return normalized[..maxChars].TrimEnd() + "\n...(truncated)";
    }
}
