using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

internal sealed class FileRunArtifactStore : IRunArtifactStore
{
    private static readonly Regex ArtifactTokenRegex = new(
        @"[^a-z0-9_-]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    );

    public string RootDirectory { get; }

    public FileRunArtifactStore(string rootDirectory)
    {
        RootDirectory = Path.GetFullPath(rootDirectory);
    }

    public string? WriteRoutineRun(RoutineRunArtifactWriteRequest request)
    {
        try
        {
            var runDir = Path.Combine(RootDirectory, request.RoutineId, "runs");
            Directory.CreateDirectory(runDir);

            var safeSource = SanitizeArtifactToken(request.Source);
            var safeStatus = SanitizeArtifactToken(request.Status);
            var attempts = Math.Max(1, request.AttemptCount);
            var fileName = $"{request.CompletedAtUtc:yyyyMMdd-HHmmss}-{safeSource}-a{attempts.ToString(CultureInfo.InvariantCulture)}-{safeStatus}.md";
            var fullPath = Path.Combine(runDir, fileName);

            AtomicFileStore.WriteAllText(
                fullPath,
                BuildRoutineRunMarkdown(request, attempts),
                ownerOnly: true
            );

            return fullPath;
        }
        catch
        {
            return null;
        }
    }

    public string? ReadText(string? artifactPath)
    {
        var fullPath = (artifactPath ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(fullPath))
        {
            return null;
        }

        try
        {
            var normalizedPath = Path.GetFullPath(fullPath);
            if (!IsPathUnderRoot(normalizedPath) || !File.Exists(normalizedPath))
            {
                return null;
            }

            return File.ReadAllText(normalizedPath, Encoding.UTF8);
        }
        catch
        {
            return null;
        }
    }

    private static string BuildRoutineRunMarkdown(RoutineRunArtifactWriteRequest request, int attempts)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"# {request.RoutineTitle}");
        builder.AppendLine();
        builder.AppendLine($"- routineId: {request.RoutineId}");
        builder.AppendLine($"- source: {request.Source}");
        builder.AppendLine($"- status: {request.Status}");
        builder.AppendLine($"- attempts: {attempts.ToString(CultureInfo.InvariantCulture)}");
        builder.AppendLine($"- startedAt: {request.StartedAtUtc.ToLocalTime():yyyy-MM-dd HH:mm:ss}");
        builder.AppendLine($"- completedAt: {request.CompletedAtUtc.ToLocalTime():yyyy-MM-dd HH:mm:ss}");
        if (!string.IsNullOrWhiteSpace(request.AssetDirectory))
        {
            builder.AppendLine($"- assetDirectory: {request.AssetDirectory}");
        }
        if (!string.IsNullOrWhiteSpace(request.TelegramStatus))
        {
            builder.AppendLine($"- telegram: {request.TelegramStatus}");
        }

        if (request.AgentMetadata != null)
        {
            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.SessionKey))
            {
                builder.AppendLine($"- agentSessionId: {request.AgentMetadata.SessionKey}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.RunId))
            {
                builder.AppendLine($"- agentRunId: {request.AgentMetadata.RunId}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.Provider))
            {
                builder.AppendLine($"- agentProvider: {request.AgentMetadata.Provider}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.Model))
            {
                builder.AppendLine($"- agentModel: {request.AgentMetadata.Model}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.ToolProfile))
            {
                builder.AppendLine($"- toolProfile: {request.AgentMetadata.ToolProfile}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.StartUrl))
            {
                builder.AppendLine($"- startUrl: {request.AgentMetadata.StartUrl}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.FinalUrl))
            {
                builder.AppendLine($"- finalUrl: {request.AgentMetadata.FinalUrl}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.PageTitle))
            {
                builder.AppendLine($"- pageTitle: {request.AgentMetadata.PageTitle}");
            }

            if (!string.IsNullOrWhiteSpace(request.AgentMetadata.ScreenshotPath))
            {
                builder.AppendLine($"- screenshotPath: {request.AgentMetadata.ScreenshotPath}");
            }

            if (request.AgentMetadata.DownloadPaths.Count > 0)
            {
                builder.AppendLine($"- downloadPaths: {string.Join(" | ", request.AgentMetadata.DownloadPaths)}");
            }
        }

        if (!string.IsNullOrWhiteSpace(request.Error))
        {
            builder.AppendLine($"- error: {request.Error}");
        }

        builder.AppendLine();
        builder.AppendLine("## Output");
        builder.AppendLine();
        builder.AppendLine(request.Output ?? string.Empty);

        return builder.ToString().TrimEnd() + Environment.NewLine;
    }

    private bool IsPathUnderRoot(string normalizedPath)
    {
        var normalizedRoot = RootDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        return normalizedPath.StartsWith(normalizedRoot, comparison);
    }

    private static string SanitizeArtifactToken(string? value)
    {
        var normalized = ArtifactTokenRegex.Replace(
            (value ?? string.Empty).Trim().ToLowerInvariant(),
            "-"
        ).Trim('-');
        return normalized.Length == 0 ? "run" : normalized;
    }
}
