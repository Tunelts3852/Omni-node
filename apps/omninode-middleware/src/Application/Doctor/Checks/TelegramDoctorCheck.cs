namespace OmniNode.Middleware;

public sealed class TelegramDoctorCheck : IDoctorCheck
{
    private readonly AppConfig _config;
    private readonly RuntimeSettings _runtimeSettings;

    public TelegramDoctorCheck(AppConfig config, RuntimeSettings runtimeSettings)
    {
        _config = config;
        _runtimeSettings = runtimeSettings;
    }

    public string Id => "telegram";

    public Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var hasBotToken = !string.IsNullOrWhiteSpace(_runtimeSettings.GetTelegramBotToken());
        var hasChatId = !string.IsNullOrWhiteSpace(_runtimeSettings.GetTelegramChatId());
        var hasAllowedUserId = !string.IsNullOrWhiteSpace(_config.TelegramAllowedUserId);
        var status = hasBotToken && hasChatId ? DoctorStatus.Ok : DoctorStatus.Warn;

        return Task.FromResult(new DoctorCheckResult(
            Id,
            status,
            status == DoctorStatus.Ok
                ? "텔레그램 필수 자격정보가 준비되었습니다."
                : "텔레그램 자격정보가 부분적으로 비어 있습니다.",
            $"botToken={(hasBotToken ? "set" : "missing")}; chatId={(hasChatId ? "set" : "missing")}; allowedUserId={(hasAllowedUserId ? "set" : "unset")}",
            status == DoctorStatus.Ok
                ? Array.Empty<string>()
                : new[] { "텔레그램 폴링과 OTP 전송을 쓰려면 Bot Token과 Chat ID를 모두 설정하세요." }
        ));
    }
}
