using System.Text;

namespace OmniNode.Middleware;

internal static class AtomicFileStore
{
    public static void WriteAllText(string path, string content, bool ownerOnly = true)
    {
        var fullPath = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(fullPath);
        if (string.IsNullOrWhiteSpace(dir))
        {
            throw new InvalidOperationException("invalid file path");
        }

        Directory.CreateDirectory(dir);
        if (!OperatingSystem.IsWindows() && ownerOnly)
        {
            File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        var tmpPath = fullPath + ".tmp";
        var bytes = Encoding.UTF8.GetBytes(content ?? string.Empty);

        using (var stream = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(flushToDisk: true);
        }

        if (!OperatingSystem.IsWindows() && ownerOnly)
        {
            File.SetUnixFileMode(tmpPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        File.Move(tmpPath, fullPath, overwrite: true);
        if (!OperatingSystem.IsWindows() && ownerOnly)
        {
            File.SetUnixFileMode(fullPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
