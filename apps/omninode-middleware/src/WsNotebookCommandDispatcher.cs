using System.Net.WebSockets;

namespace OmniNode.Middleware;

internal sealed class WsNotebookCommandDispatcher
{
    internal delegate Task SendNotebookResultDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string action,
        NotebookActionResult result,
        CancellationToken cancellationToken
    );

    private readonly INotebookApplicationService _notebookService;
    private readonly SendNotebookResultDelegate _sendNotebookResultAsync;

    public WsNotebookCommandDispatcher(
        INotebookApplicationService notebookService,
        SendNotebookResultDelegate sendNotebookResultAsync
    )
    {
        _notebookService = notebookService;
        _sendNotebookResultAsync = sendNotebookResultAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "notebook_get")
        {
            await _sendNotebookResultAsync(
                socket,
                sendLock,
                "get",
                await _notebookService.GetNotebookAsync(message.ProjectKey, cancellationToken),
                cancellationToken
            );
            return true;
        }

        if (message.Type == "notebook_append")
        {
            var kind = (message.Kind ?? string.Empty).Trim().ToLowerInvariant();
            var content = message.Text ?? string.Empty;
            var result = kind switch
            {
                "learning" => await _notebookService.AppendLearningAsync(message.ProjectKey, content, cancellationToken),
                "decision" => await _notebookService.AppendDecisionAsync(message.ProjectKey, content, cancellationToken),
                "verification" => await _notebookService.AppendVerificationAsync(message.ProjectKey, content, cancellationToken),
                _ => new NotebookActionResult(false, "kind는 learning, decision, verification 중 하나여야 합니다.", null)
            };
            await _sendNotebookResultAsync(socket, sendLock, "append", result, cancellationToken);
            return true;
        }

        if (message.Type == "handoff_create")
        {
            await _sendNotebookResultAsync(
                socket,
                sendLock,
                "handoff",
                await _notebookService.CreateHandoffAsync(message.ProjectKey, cancellationToken),
                cancellationToken
            );
            return true;
        }

        return false;
    }
}
