using System.Net.WebSockets;
using System.Text.Json;

namespace OmniNode.Middleware;

internal sealed class WsRefactorCommandDispatcher
{
    internal delegate Task SendRefactorActionResultDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string action,
        RefactorActionResult result,
        CancellationToken cancellationToken
    );

    private readonly IRefactorApplicationService _refactorService;
    private readonly SendRefactorActionResultDelegate _sendRefactorActionResultAsync;

    public WsRefactorCommandDispatcher(
        IRefactorApplicationService refactorService,
        SendRefactorActionResultDelegate sendRefactorActionResultAsync
    )
    {
        _refactorService = refactorService;
        _sendRefactorActionResultAsync = sendRefactorActionResultAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "refactor_read")
        {
            var path = (message.FilePath ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(path))
            {
                await SendMissingFieldAsync(socket, sendLock, "path", cancellationToken);
                return true;
            }

            var result = await _refactorService.ReadWithAnchorsAsync(path, cancellationToken);
            await _sendRefactorActionResultAsync(socket, sendLock, "read", result, cancellationToken);
            return true;
        }

        if (message.Type == "refactor_preview")
        {
            var path = (message.FilePath ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(path))
            {
                await SendMissingFieldAsync(socket, sendLock, "path", cancellationToken);
                return true;
            }

            AnchorEditRequest[] edits;
            try
            {
                edits = RefactorJson.DeserializeEdits(message.RefactorEditsJson ?? "[]");
            }
            catch (JsonException)
            {
                await WebSocketGateway.SendTextAsync(
                    socket,
                    sendLock,
                    "{\"type\":\"error\",\"message\":\"edits 형식이 올바르지 않습니다.\"}",
                    cancellationToken
                );
                return true;
            }

            var result = await _refactorService.PreviewRefactorAsync(path, edits, cancellationToken);
            await _sendRefactorActionResultAsync(socket, sendLock, "preview", result, cancellationToken);
            return true;
        }

        if (message.Type == "refactor_apply")
        {
            var previewId = (message.PreviewId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(previewId))
            {
                await SendMissingFieldAsync(socket, sendLock, "previewId", cancellationToken);
                return true;
            }

            var result = await _refactorService.ApplyRefactorAsync(previewId, cancellationToken);
            await _sendRefactorActionResultAsync(socket, sendLock, "apply", result, cancellationToken);
            return true;
        }

        if (message.Type == "lsp_rename")
        {
            var path = (message.FilePath ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(path))
            {
                await SendMissingFieldAsync(socket, sendLock, "path", cancellationToken);
                return true;
            }

            var result = await _refactorService.RunLspRenameAsync(
                path,
                message.Symbol ?? string.Empty,
                message.NewName ?? string.Empty,
                cancellationToken
            );
            await _sendRefactorActionResultAsync(socket, sendLock, "lsp_rename", result, cancellationToken);
            return true;
        }

        if (message.Type == "ast_replace")
        {
            var path = (message.FilePath ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(path))
            {
                await SendMissingFieldAsync(socket, sendLock, "path", cancellationToken);
                return true;
            }

            var result = await _refactorService.RunAstReplaceAsync(
                path,
                message.Pattern ?? string.Empty,
                message.Replacement ?? string.Empty,
                cancellationToken
            );
            await _sendRefactorActionResultAsync(socket, sendLock, "ast_replace", result, cancellationToken);
            return true;
        }

        return false;
    }

    private static Task SendMissingFieldAsync(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string fieldName,
        CancellationToken cancellationToken
    )
    {
        return WebSocketGateway.SendTextAsync(
            socket,
            sendLock,
            $"{{\"type\":\"error\",\"message\":\"{WebSocketGateway.EscapeJson(fieldName)} is required\"}}",
            cancellationToken
        );
    }
}
