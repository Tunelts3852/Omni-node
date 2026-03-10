using System.Net.WebSockets;

namespace OmniNode.Middleware;

internal sealed class WsContextCommandDispatcher
{
    internal delegate Task SendProjectContextDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        ProjectContextSnapshot snapshot,
        CancellationToken cancellationToken
    );

    internal delegate Task SendSkillsListDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        SkillManifestListResult result,
        CancellationToken cancellationToken
    );

    internal delegate Task SendCommandsListDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CommandTemplateListResult result,
        CancellationToken cancellationToken
    );

    private readonly IContextApplicationService _contextService;
    private readonly SendProjectContextDelegate _sendProjectContextAsync;
    private readonly SendSkillsListDelegate _sendSkillsListAsync;
    private readonly SendCommandsListDelegate _sendCommandsListAsync;

    public WsContextCommandDispatcher(
        IContextApplicationService contextService,
        SendProjectContextDelegate sendProjectContextAsync,
        SendSkillsListDelegate sendSkillsListAsync,
        SendCommandsListDelegate sendCommandsListAsync
    )
    {
        _contextService = contextService;
        _sendProjectContextAsync = sendProjectContextAsync;
        _sendSkillsListAsync = sendSkillsListAsync;
        _sendCommandsListAsync = sendCommandsListAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "context_scan")
        {
            await _sendProjectContextAsync(
                socket,
                sendLock,
                await _contextService.ScanProjectContextAsync(cancellationToken),
                cancellationToken
            );
            return true;
        }

        if (message.Type == "skills_list")
        {
            await _sendSkillsListAsync(
                socket,
                sendLock,
                await _contextService.ListSkillsAsync(cancellationToken),
                cancellationToken
            );
            return true;
        }

        if (message.Type == "commands_list")
        {
            await _sendCommandsListAsync(
                socket,
                sendLock,
                await _contextService.ListCommandsAsync(cancellationToken),
                cancellationToken
            );
            return true;
        }

        return false;
    }
}
