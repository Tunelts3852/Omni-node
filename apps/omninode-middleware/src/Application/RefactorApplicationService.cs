namespace OmniNode.Middleware;

public sealed class RefactorApplicationService : IRefactorApplicationService
{
    private readonly CommandService _inner;

    public RefactorApplicationService(CommandService inner)
    {
        _inner = inner;
    }

    public Task<RefactorActionResult> ReadWithAnchorsAsync(string path, CancellationToken cancellationToken)
    {
        return _inner.ReadWithAnchorsAsync(path, cancellationToken);
    }

    public Task<RefactorActionResult> PreviewRefactorAsync(
        string path,
        IReadOnlyList<AnchorEditRequest>? edits,
        CancellationToken cancellationToken
    )
    {
        return _inner.PreviewRefactorAsync(path, edits, cancellationToken);
    }

    public Task<RefactorActionResult> ApplyRefactorAsync(string previewId, CancellationToken cancellationToken)
    {
        return _inner.ApplyRefactorAsync(previewId, cancellationToken);
    }

    public Task<RefactorActionResult> RunLspRenameAsync(
        string path,
        string symbol,
        string newName,
        CancellationToken cancellationToken
    )
    {
        return _inner.RunLspRenameAsync(path, symbol, newName, cancellationToken);
    }

    public Task<RefactorActionResult> RunAstReplaceAsync(
        string path,
        string pattern,
        string replacement,
        CancellationToken cancellationToken
    )
    {
        return _inner.RunAstReplaceAsync(path, pattern, replacement, cancellationToken);
    }
}
