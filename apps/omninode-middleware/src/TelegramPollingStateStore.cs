using System.Globalization;
using System.Text;

namespace OmniNode.Middleware;

public sealed class TelegramPollingStateStore
{
    private readonly string _offsetPath;
    private readonly string _lockPath;

    public TelegramPollingStateStore(string offsetPath, string lockPath)
    {
        _offsetPath = Path.GetFullPath(offsetPath);
        _lockPath = Path.GetFullPath(lockPath);
    }

    public long LoadNextOffset()
    {
        try
        {
            if (!File.Exists(_offsetPath))
            {
                return 0;
            }

            var text = File.ReadAllText(_offsetPath, Encoding.UTF8).Trim();
            if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var offset) && offset > 0)
            {
                return offset;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[telegram] offset load failed: {ex.Message}");
        }

        return 0;
    }

    public void SaveNextOffset(long offset)
    {
        if (offset < 0)
        {
            return;
        }

        AtomicFileStore.WriteAllText(
            _offsetPath,
            offset.ToString(CultureInfo.InvariantCulture),
            ownerOnly: true
        );
    }

    public IDisposable? TryAcquireLease()
    {
        try
        {
            var dir = Path.GetDirectoryName(_lockPath);
            if (!string.IsNullOrWhiteSpace(dir))
            {
                Directory.CreateDirectory(dir);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(
                        dir,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    );
                }
            }

            var stream = new FileStream(_lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            try
            {
                var payload = Encoding.UTF8.GetBytes($"{Environment.ProcessId}\n{DateTimeOffset.UtcNow:O}\n");
                stream.SetLength(0);
                stream.Write(payload, 0, payload.Length);
                stream.Flush(flushToDisk: true);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(_lockPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
            }
            catch
            {
                stream.Dispose();
                throw;
            }

            return new Lease(stream);
        }
        catch (IOException)
        {
            return null;
        }
    }

    private sealed class Lease : IDisposable
    {
        private FileStream? _stream;

        public Lease(FileStream stream)
        {
            _stream = stream;
        }

        public void Dispose()
        {
            _stream?.Dispose();
            _stream = null;
        }
    }
}
