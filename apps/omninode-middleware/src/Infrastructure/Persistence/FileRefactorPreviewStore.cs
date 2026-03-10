using System.Text;

namespace OmniNode.Middleware;

public sealed class FileRefactorPreviewStore
{
    private readonly IStatePathResolver _pathResolver;
    private readonly TimeSpan _ttl;
    private readonly string? _previewRootDir;

    public FileRefactorPreviewStore(
        IStatePathResolver pathResolver,
        int ttlMinutes,
        string? previewRootDir = null
    )
    {
        _pathResolver = pathResolver;
        _ttl = TimeSpan.FromMinutes(Math.Max(5, ttlMinutes));
        _previewRootDir = string.IsNullOrWhiteSpace(previewRootDir)
            ? null
            : Path.GetFullPath(previewRootDir);
    }

    public void Save(RefactorPreviewRecord record)
    {
        DeleteExpired();
        AtomicFileStore.WriteAllText(
            GetPreviewPath(record.PreviewId),
            RefactorJson.Serialize(record, indented: true),
            ownerOnly: true
        );
    }

    public RefactorPreviewRecord? TryLoad(string previewId)
    {
        DeleteExpired();
        var path = GetPreviewPath(previewId);
        if (!File.Exists(path))
        {
            return null;
        }

        if (IsExpired(path))
        {
            Delete(previewId);
            return null;
        }

        try
        {
            var json = File.ReadAllText(path, Encoding.UTF8);
            return RefactorJson.DeserializePreviewRecord(json);
        }
        catch
        {
            return null;
        }
    }

    public void Delete(string previewId)
    {
        var path = GetPreviewPath(previewId);
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }

    public void DeleteExpired()
    {
        var root = GetPreviewRoot();
        if (!Directory.Exists(root))
        {
            return;
        }

        foreach (var path in Directory.GetFiles(root, "*.json", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (IsExpired(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }
    }

    private bool IsExpired(string path)
    {
        try
        {
            var modifiedAtUtc = File.GetLastWriteTimeUtc(path);
            return DateTime.UtcNow - modifiedAtUtc > _ttl;
        }
        catch
        {
            return false;
        }
    }

    private string GetPreviewRoot()
    {
        return _previewRootDir ?? _pathResolver.GetRefactorPreviewRoot();
    }

    private string GetPreviewPath(string previewId)
    {
        return Path.Combine(GetPreviewRoot(), $"{previewId.Trim()}.json");
    }
}
