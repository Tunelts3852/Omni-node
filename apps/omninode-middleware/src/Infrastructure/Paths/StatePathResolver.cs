using System.Runtime.InteropServices;

namespace OmniNode.Middleware;

public interface IStatePathResolver
{
    string StateRootDir { get; }
    string WorkspaceRootDir { get; }
    string DashboardIndexPath { get; }
    string CoreSocketPath { get; }
    string RoutinePromptDir { get; }
    string ResolveStateFilePath(string fileName);
    string ResolveStateDirectoryPath(string directoryName);
}

public sealed class DefaultStatePathResolver : IStatePathResolver
{
    public string StateRootDir { get; }
    public string WorkspaceRootDir { get; }
    public string DashboardIndexPath { get; }
    public string CoreSocketPath { get; }
    public string RoutinePromptDir { get; }

    private DefaultStatePathResolver(
        string stateRootDir,
        string workspaceRootDir,
        string dashboardIndexPath,
        string coreSocketPath
    )
    {
        StateRootDir = stateRootDir;
        WorkspaceRootDir = workspaceRootDir;
        DashboardIndexPath = dashboardIndexPath;
        CoreSocketPath = coreSocketPath;
        RoutinePromptDir = Path.Combine(WorkspaceRootDir, "_routine_prompts");
    }

    public static DefaultStatePathResolver CreateDefault()
    {
        var stateRootDir = ResolveDefaultStateDir();
        var workspaceRootDir = ResolveDefaultWorkspaceRootDir();
        var dashboardIndexPath = ResolveDefaultDashboardIndexPath();
        var coreSocketPath = ResolveDefaultCoreSocketPath();
        return new DefaultStatePathResolver(
            stateRootDir,
            workspaceRootDir,
            dashboardIndexPath,
            coreSocketPath
        );
    }

    public string ResolveStateFilePath(string fileName)
    {
        return Path.Combine(StateRootDir, fileName);
    }

    public string ResolveStateDirectoryPath(string directoryName)
    {
        return Path.Combine(StateRootDir, directoryName);
    }

    private static string ResolveDefaultDashboardIndexPath()
    {
        var baseDir = AppContext.BaseDirectory;
        var cwd = Directory.GetCurrentDirectory();
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(baseDir, "../../../../omninode-dashboard/index.html")),
            Path.GetFullPath(Path.Combine(cwd, "apps/omninode-dashboard/index.html")),
            Path.GetFullPath(Path.Combine(cwd, "omninode-dashboard/index.html")),
            Path.GetFullPath(Path.Combine(cwd, "../omninode-dashboard/index.html")),
            Path.GetFullPath(Path.Combine(cwd, "../apps/omninode-dashboard/index.html"))
        };

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return candidates[0];
    }

    private static string ResolveDefaultCoreSocketPath()
    {
        try
        {
            var uid = GetCurrentUnixUid();
            return $"/tmp/omninode_core.{uid}.sock";
        }
        catch
        {
            return "/tmp/omninode_core.sock";
        }
    }

    private static string ResolveDefaultWorkspaceRootDir()
    {
        var baseDir = AppContext.BaseDirectory;
        var cwd = Directory.GetCurrentDirectory();
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(baseDir, "../../../../../workspace/coding")),
            Path.GetFullPath(Path.Combine(baseDir, "../../../../../coding")),
            Path.GetFullPath(Path.Combine(cwd, "workspace/coding")),
            Path.GetFullPath(Path.Combine(cwd, "coding")),
            Path.GetFullPath(Path.Combine(cwd, "../Omni-node/coding")),
            Path.GetFullPath(Path.Combine(cwd, "../coding")),
            Path.GetFullPath(Path.Combine(cwd, "../workspace/coding"))
        };

        foreach (var candidate in candidates)
        {
            var parent = Directory.GetParent(candidate);
            if (parent != null && Directory.Exists(parent.FullName))
            {
                return candidate;
            }
        }

        return candidates[0];
    }

    private static string ResolveDefaultStateDir()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(home))
        {
            return "/tmp";
        }

        return Path.Combine(home, ".omninode");
    }

    private static uint GetCurrentUnixUid()
    {
        if (OperatingSystem.IsWindows())
        {
            return 0;
        }

        try
        {
            return PosixNative.getuid();
        }
        catch
        {
            return 0;
        }
    }

    private static class PosixNative
    {
        [DllImport("libc", SetLastError = true)]
        internal static extern uint getuid();
    }
}
