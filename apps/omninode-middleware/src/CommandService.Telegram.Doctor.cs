namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private async Task<string?> TryHandleTelegramDoctorCommandAsync(
        string text,
        CancellationToken cancellationToken
    )
    {
        if (!text.StartsWith("/doctor", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length >= 2 && tokens[1].Equals("help", StringComparison.OrdinalIgnoreCase))
        {
            return BuildTelegramHelpText("doctor");
        }

        var latestOnly = tokens.Skip(1).Any(token => token.Equals("last", StringComparison.OrdinalIgnoreCase));
        var json = tokens.Skip(1).Any(token => token.Equals("json", StringComparison.OrdinalIgnoreCase));

        return await ExecuteDoctorReportCommandAsync(json, latestOnly, cancellationToken);
    }
}
