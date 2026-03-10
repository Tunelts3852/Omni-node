namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private async Task<string?> TryHandleTelegramPlanCommandAsync(
        string text,
        CancellationToken cancellationToken
    )
    {
        if (!text.StartsWith("/plan", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return await ExecutePlanSlashCommandAsync(tokens, "telegram", cancellationToken);
    }
}
