namespace OmniNode.Middleware;

public sealed class TelegramUpdateLoop
{
    private readonly TelegramClient _telegramClient;
    private readonly ICommandExecutionService _commandService;
    private readonly AppConfig _config;
    private readonly Dictionary<string, CommandWindow> _commandWindows = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _rateLock = new();
    private long _offset;

    public TelegramUpdateLoop(
        TelegramClient telegramClient,
        ICommandExecutionService commandService,
        AppConfig config
    )
    {
        _telegramClient = telegramClient;
        _commandService = commandService;
        _config = config;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            IReadOnlyList<TelegramUpdate> updates;

            try
            {
                updates = await _telegramClient.GetUpdatesAsync(_offset, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[telegram] polling error: {ex.Message}");
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
                continue;
            }

            foreach (var update in updates)
            {
                if (update.UpdateId >= _offset)
                {
                    _offset = update.UpdateId + 1;
                }

                var hasText = !string.IsNullOrWhiteSpace(update.Text);
                var hasAttachments = update.Attachments != null && update.Attachments.Count > 0;
                if (!hasText && !hasAttachments)
                {
                    continue;
                }

                if (!IsAuthorizedUpdate(update))
                {
                    continue;
                }

                var commandKey = ResolveCommandBucket(update.Text ?? string.Empty);
                if (!AllowCommand(commandKey))
                {
                    await _telegramClient.SendMessageAsync(
                        $"rate limit exceeded: {commandKey} 명령 요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
                        cancellationToken
                    );
                    continue;
                }

                try
                {
                    var input = hasText ? update.Text!.Trim() : "첨부 파일을 분석해줘";
                    var result = await _commandService.ExecuteAsync(
                        input,
                        "telegram",
                        cancellationToken,
                        update.Attachments ?? Array.Empty<InputAttachment>(),
                        null,
                        true
                    );
                    await _telegramClient.SendMessageAsync(result, cancellationToken);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[telegram] handle error: {ex.Message}");
                    await _telegramClient.SendMessageAsync($"error: {ex.Message}", cancellationToken);
                }
            }
        }
    }

    private bool IsAuthorizedUpdate(TelegramUpdate update)
    {
        var expectedChatId = _config.TelegramChatId?.Trim();
        if (!string.IsNullOrWhiteSpace(expectedChatId))
        {
            var incomingChatId = (update.ChatId ?? string.Empty).Trim();
            if (!string.Equals(expectedChatId, incomingChatId, StringComparison.Ordinal))
            {
                return false;
            }
        }

        var expectedUserId = _config.TelegramAllowedUserId?.Trim();
        if (!string.IsNullOrWhiteSpace(expectedUserId))
        {
            var incomingUserId = (update.FromUserId ?? string.Empty).Trim();
            if (!string.Equals(expectedUserId, incomingUserId, StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    private static string ResolveCommandBucket(string text)
    {
        var normalized = (text ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.StartsWith("/kill ", StringComparison.Ordinal))
        {
            return "kill";
        }

        if (normalized.StartsWith("/metrics", StringComparison.Ordinal))
        {
            return "metrics";
        }

        if (normalized.StartsWith("/llm", StringComparison.Ordinal))
        {
            return "llm";
        }

        if (normalized.StartsWith("/routine", StringComparison.Ordinal)
            || normalized.StartsWith("/routines", StringComparison.Ordinal))
        {
            return "routine";
        }

        return "default";
    }

    private bool AllowCommand(string bucket)
    {
        var now = DateTimeOffset.UtcNow;
        var (limit, window) = ResolveRatePolicy(bucket);
        lock (_rateLock)
        {
            if (!_commandWindows.TryGetValue(bucket, out var current))
            {
                _commandWindows[bucket] = new CommandWindow(now, 1);
                return true;
            }

            if (now - current.StartUtc >= window)
            {
                _commandWindows[bucket] = new CommandWindow(now, 1);
                return true;
            }

            if (current.Count >= limit)
            {
                return false;
            }

            _commandWindows[bucket] = current with { Count = current.Count + 1 };
            return true;
        }
    }

    private static (int Limit, TimeSpan Window) ResolveRatePolicy(string bucket)
    {
        if (bucket == "kill")
        {
            return (3, TimeSpan.FromMinutes(1));
        }

        if (bucket == "metrics")
        {
            return (20, TimeSpan.FromMinutes(1));
        }

        if (bucket == "llm")
        {
            return (20, TimeSpan.FromMinutes(1));
        }

        if (bucket == "routine")
        {
            return (12, TimeSpan.FromMinutes(1));
        }

        return (40, TimeSpan.FromMinutes(1));
    }

    private sealed record CommandWindow(DateTimeOffset StartUtc, int Count);
}
