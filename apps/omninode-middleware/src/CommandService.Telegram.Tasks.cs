namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private async Task<string?> TryHandleTelegramTaskCommandAsync(
        string text,
        CancellationToken cancellationToken
    )
    {
        if (!text.StartsWith("/task", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return await ExecuteTaskSlashCommandAsync(tokens, "telegram", cancellationToken);
    }
}
