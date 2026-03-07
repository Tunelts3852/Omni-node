namespace OmniNode.Middleware;

public sealed class CodingApplicationService : ICodingApplicationService
{
    private readonly CommandService _inner;

    public CodingApplicationService(CommandService inner)
    {
        _inner = inner;
    }

    public Task<CodingRunResult> RunCodingSingleAsync(CodingRunRequest request, CancellationToken cancellationToken, Action<CodingProgressUpdate>? progressCallback = null) => _inner.RunCodingSingleAsync(request, cancellationToken, progressCallback);
    public Task<CodingRunResult> RunCodingOrchestrationAsync(CodingRunRequest request, CancellationToken cancellationToken, Action<CodingProgressUpdate>? progressCallback = null) => _inner.RunCodingOrchestrationAsync(request, cancellationToken, progressCallback);
    public Task<CodingRunResult> RunCodingMultiAsync(CodingRunRequest request, CancellationToken cancellationToken, Action<CodingProgressUpdate>? progressCallback = null) => _inner.RunCodingMultiAsync(request, cancellationToken, progressCallback);
}
