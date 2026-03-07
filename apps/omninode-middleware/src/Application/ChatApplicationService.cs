namespace OmniNode.Middleware;

public sealed class ChatApplicationService : IChatApplicationService
{
    private readonly CommandService _inner;

    public ChatApplicationService(CommandService inner)
    {
        _inner = inner;
    }

    public Task<ConversationChatResult> ChatSingleWithStateAsync(ChatRequest request, CancellationToken cancellationToken, Action<ChatStreamUpdate>? streamCallback = null) => _inner.ChatSingleWithStateAsync(request, cancellationToken, streamCallback);
    public Task<ConversationChatResult> ChatOrchestrationWithStateAsync(ChatRequest request, CancellationToken cancellationToken) => _inner.ChatOrchestrationWithStateAsync(request, cancellationToken);
    public Task<ConversationMultiResult> ChatMultiWithStateAsync(MultiChatRequest request, CancellationToken cancellationToken) => _inner.ChatMultiWithStateAsync(request, cancellationToken);
}
