namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private async Task<string?> TryHandleTelegramNotebookCommandAsync(
        string text,
        CancellationToken cancellationToken
    )
    {
        if (text.StartsWith("/notebook", StringComparison.OrdinalIgnoreCase))
        {
            var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return await ExecuteNotebookSlashCommandAsync(tokens, "telegram", cancellationToken);
        }

        if (text.StartsWith("/handoff", StringComparison.OrdinalIgnoreCase))
        {
            var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return await ExecuteHandoffSlashCommandAsync(tokens, "telegram", cancellationToken);
        }

        return null;
    }
}
