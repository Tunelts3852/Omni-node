using System.Runtime.InteropServices;

namespace OmniNode.Middleware;

public sealed class AuditLogger
{
    private readonly string _path;
    private readonly object _lock = new();

    public AuditLogger(string path)
    {
        _path = Path.GetFullPath(path);
        EnsureFile();
    }

    public void Log(string source, string action, string status, string message)
    {
        var line = "{"
            + $"\"ts\":\"{DateTimeOffset.UtcNow:O}\","
            + $"\"source\":\"{EscapeJson(source)}\","
            + $"\"action\":\"{EscapeJson(action)}\","
            + $"\"status\":\"{EscapeJson(status)}\","
            + $"\"message\":\"{EscapeJson(Trim(message, 1200))}\""
            + "}";

        lock (_lock)
        {
            File.AppendAllText(_path, line + Environment.NewLine);
        }
    }

    private void EnsureFile()
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        if (!File.Exists(_path))
        {
            using var _ = File.Create(_path);
        }

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                File.SetUnixFileMode(_path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            catch
            {
            }
        }
    }

    private static string Trim(string value, int max)
    {
        return value.Length <= max ? value : value[..max] + "...(truncated)";
    }

    private static string EscapeJson(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
    }
}

