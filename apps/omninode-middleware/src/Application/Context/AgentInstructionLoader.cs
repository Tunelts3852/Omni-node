using System.Text;

namespace OmniNode.Middleware;

public sealed class AgentInstructionLoader
{
    private readonly IStatePathResolver _pathResolver;
    private readonly string[] _fallbackFileNames;
    private readonly int _maxBytes;

    public AgentInstructionLoader(IStatePathResolver pathResolver, AppConfig config)
    {
        _pathResolver = pathResolver;
        _fallbackFileNames = (config.ProjectContextFallbackFilenamesCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        _maxBytes = Math.Max(2048, config.ProjectContextMaxBytes);
    }

    public InstructionBundle Load(string projectRoot, string currentDirectory)
    {
        var builder = new StringBuilder();
        var sources = new List<InstructionSource>();
        var remainingBytes = _maxBytes;
        var order = 0;

        var globalAgentsPath = _pathResolver.ResolveStateFilePath("AGENTS.md");
        AppendSource(globalAgentsPath, "global");

        foreach (var directory in EnumerateDirectories(projectRoot, currentDirectory))
        {
            AppendSource(Path.Combine(directory, "AGENTS.override.md"), ResolveScope(directory, projectRoot, currentDirectory, "override"));
            AppendSource(Path.Combine(directory, "AGENTS.md"), ResolveScope(directory, projectRoot, currentDirectory, "agents"));
            foreach (var fallbackFileName in _fallbackFileNames)
            {
                if (fallbackFileName.Equals("AGENTS.md", StringComparison.OrdinalIgnoreCase)
                    || fallbackFileName.Equals("AGENTS.override.md", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                AppendSource(
                    Path.Combine(directory, fallbackFileName),
                    ResolveScope(directory, projectRoot, currentDirectory, "fallback")
                );
            }
        }

        return new InstructionBundle(sources, builder.ToString().Trim());

        void AppendSource(string path, string scope)
        {
            if (remainingBytes <= 0 || !File.Exists(path))
            {
                return;
            }

            string text;
            try
            {
                text = File.ReadAllText(path, Encoding.UTF8).Trim();
            }
            catch
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(text))
            {
                return;
            }

            var header = $"[instruction_source scope={scope} path={path}]";
            var payload = text;
            var encodedLength = Encoding.UTF8.GetByteCount(header) + Environment.NewLine.Length + Encoding.UTF8.GetByteCount(payload);
            if (encodedLength > remainingBytes)
            {
                payload = TrimToUtf8ByteCount(payload, Math.Max(0, remainingBytes - Encoding.UTF8.GetByteCount(header) - 32));
                if (payload.Length == 0)
                {
                    return;
                }

                payload = $"{payload}\n...(truncated)";
                encodedLength = Encoding.UTF8.GetByteCount(header) + Environment.NewLine.Length + Encoding.UTF8.GetByteCount(payload);
            }

            if (builder.Length > 0)
            {
                builder.AppendLine();
                builder.AppendLine();
            }

            builder.AppendLine(header);
            builder.Append(payload);
            sources.Add(new InstructionSource(path, scope, ++order));
            remainingBytes -= encodedLength;
        }
    }

    private static IEnumerable<string> EnumerateDirectories(string projectRoot, string currentDirectory)
    {
        var root = Path.GetFullPath(projectRoot);
        var current = Path.GetFullPath(currentDirectory);
        var stack = new Stack<string>();
        var pointer = current;
        while (true)
        {
            stack.Push(pointer);
            if (string.Equals(pointer, root, PathComparison()))
            {
                break;
            }

            var parent = Directory.GetParent(pointer);
            if (parent == null)
            {
                break;
            }

            pointer = parent.FullName;
        }

        return stack;
    }

    private static string ResolveScope(string directory, string projectRoot, string currentDirectory, string kind)
    {
        if (string.Equals(directory, projectRoot, PathComparison()))
        {
            return $"project-root:{kind}";
        }

        if (string.Equals(directory, currentDirectory, PathComparison()))
        {
            return $"cwd:{kind}";
        }

        return $"nested:{kind}";
    }

    private static StringComparison PathComparison()
    {
        return OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
    }

    private static string TrimToUtf8ByteCount(string value, int maxBytes)
    {
        if (maxBytes <= 0 || string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        var usedBytes = 0;
        foreach (var ch in value)
        {
            var nextBytes = Encoding.UTF8.GetByteCount(new[] { ch });
            if (usedBytes + nextBytes > maxBytes)
            {
                break;
            }

            builder.Append(ch);
            usedBytes += nextBytes;
        }

        return builder.ToString().TrimEnd();
    }
}
