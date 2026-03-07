using System.Net.WebSockets;

namespace OmniNode.Middleware;

internal sealed class WsSetupCommandDispatcher
{
    private readonly ISettingsApplicationService _settingsService;
    private readonly GroqModelCatalog _groqModelCatalog;
    private readonly LlmRouter _llmRouter;
    private readonly Func<WebSocket, SemaphoreSlim, CancellationToken, Task> _sendSettingsStateAsync;
    private readonly Func<WebSocket, SemaphoreSlim, CancellationToken, Task> _sendGroqModelsAsync;
    private readonly Func<WebSocket, SemaphoreSlim, CancellationToken, Task> _sendCopilotModelsAsync;
    private readonly Func<WebSocket, SemaphoreSlim, CancellationToken, bool, Task> _sendUsageStatsAsync;

    public WsSetupCommandDispatcher(
        ISettingsApplicationService settingsService,
        GroqModelCatalog groqModelCatalog,
        LlmRouter llmRouter,
        Func<WebSocket, SemaphoreSlim, CancellationToken, Task> sendSettingsStateAsync,
        Func<WebSocket, SemaphoreSlim, CancellationToken, Task> sendGroqModelsAsync,
        Func<WebSocket, SemaphoreSlim, CancellationToken, Task> sendCopilotModelsAsync,
        Func<WebSocket, SemaphoreSlim, CancellationToken, bool, Task> sendUsageStatsAsync
    )
    {
        _settingsService = settingsService;
        _groqModelCatalog = groqModelCatalog;
        _llmRouter = llmRouter;
        _sendSettingsStateAsync = sendSettingsStateAsync;
        _sendGroqModelsAsync = sendGroqModelsAsync;
        _sendCopilotModelsAsync = sendCopilotModelsAsync;
        _sendUsageStatsAsync = sendUsageStatsAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "get_settings" || message.Type == "get_setup_state")
        {
            await _sendSettingsStateAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "set_telegram_credentials")
        {
            var result = _settingsService.UpdateTelegramCredentials(message.TelegramBotToken, message.TelegramChatId, message.Persist);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"settings_result\",\"ok\":{(IsSettingsOperationSuccess(result) ? "true" : "false")},\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            await _sendSettingsStateAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "delete_telegram_credentials")
        {
            var result = _settingsService.DeleteTelegramCredentials(message.Persist);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"settings_result\",\"ok\":{(IsSettingsOperationSuccess(result) ? "true" : "false")},\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            await _sendSettingsStateAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "set_llm_credentials")
        {
            var result = _settingsService.UpdateLlmCredentials(
                message.GroqApiKey,
                message.GeminiApiKey,
                message.CerebrasApiKey,
                message.CodexApiKey,
                message.Persist
            );
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"settings_result\",\"ok\":{(IsSettingsOperationSuccess(result) ? "true" : "false")},\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            await _sendSettingsStateAsync(socket, sendLock, cancellationToken);
            await _sendGroqModelsAsync(socket, sendLock, cancellationToken);
            await _sendCopilotModelsAsync(socket, sendLock, cancellationToken);
            await _sendUsageStatsAsync(socket, sendLock, cancellationToken, false);
            return true;
        }

        if (message.Type == "delete_llm_credentials")
        {
            var result = _settingsService.DeleteLlmCredentials(message.Persist);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"settings_result\",\"ok\":{(IsSettingsOperationSuccess(result) ? "true" : "false")},\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            await _sendSettingsStateAsync(socket, sendLock, cancellationToken);
            await _sendGroqModelsAsync(socket, sendLock, cancellationToken);
            await _sendCopilotModelsAsync(socket, sendLock, cancellationToken);
            await _sendUsageStatsAsync(socket, sendLock, cancellationToken, false);
            return true;
        }

        if (message.Type == "test_telegram")
        {
            var result = await _settingsService.SendTelegramTestAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"settings_result\",\"ok\":{(IsSettingsOperationSuccess(result) ? "true" : "false")},\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "get_copilot_status")
        {
            var status = await _settingsService.GetCopilotStatusAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                "{"
                + "\"type\":\"copilot_status\","
                + $"\"installed\":{(status.Installed ? "true" : "false")},"
                + $"\"authenticated\":{(status.Authenticated ? "true" : "false")},"
                + $"\"mode\":\"{WebSocketGateway.EscapeJson(status.Mode)}\","
                + $"\"detail\":\"{WebSocketGateway.EscapeJson(status.Detail)}\""
                + "}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "get_codex_status")
        {
            var status = await _settingsService.GetCodexStatusAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                "{"
                + "\"type\":\"codex_status\","
                + $"\"installed\":{(status.Installed ? "true" : "false")},"
                + $"\"authenticated\":{(status.Authenticated ? "true" : "false")},"
                + $"\"mode\":\"{WebSocketGateway.EscapeJson(status.Mode)}\","
                + $"\"detail\":\"{WebSocketGateway.EscapeJson(status.Detail)}\""
                + "}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "get_usage_stats")
        {
            await _sendUsageStatsAsync(socket, sendLock, cancellationToken, true);
            return true;
        }

        if (message.Type == "start_copilot_login")
        {
            var result = await _settingsService.StartCopilotLoginAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"copilot_login_result\",\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "start_codex_login")
        {
            var result = await _settingsService.StartCodexLoginAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"codex_login_result\",\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "logout_codex")
        {
            var result = await _settingsService.LogoutCodexAsync(cancellationToken);
            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"codex_logout_result\",\"message\":\"{WebSocketGateway.EscapeJson(result)}\"}}",
                cancellationToken
            );
            return true;
        }

        if (message.Type == "get_copilot_models")
        {
            await _sendCopilotModelsAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "set_copilot_model")
        {
            if (string.IsNullOrWhiteSpace(message.Model))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"model is required\"}", cancellationToken);
                return true;
            }

            var models = await _settingsService.GetCopilotModelsAsync(cancellationToken);
            var requestedModel = message.Model.Trim();
            if (!models.Any(x => x.Id.Equals(requestedModel, StringComparison.OrdinalIgnoreCase)))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unknown copilot model\"}", cancellationToken);
                return true;
            }

            if (!_settingsService.TrySetSelectedCopilotModel(requestedModel))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"invalid model id\"}", cancellationToken);
                return true;
            }

            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"copilot_model_set\",\"ok\":true,\"model\":\"{WebSocketGateway.EscapeJson(requestedModel)}\"}}",
                cancellationToken
            );
            await _sendCopilotModelsAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "get_groq_models")
        {
            await _sendGroqModelsAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "set_groq_model")
        {
            if (string.IsNullOrWhiteSpace(message.Model))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"model is required\"}", cancellationToken);
                return true;
            }

            var models = await _groqModelCatalog.GetModelsAsync(cancellationToken);
            var requestedModel = message.Model.Trim();
            if (!models.Any(x => x.Id.Equals(requestedModel, StringComparison.OrdinalIgnoreCase)))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"unknown model\"}", cancellationToken);
                return true;
            }

            if (!_llmRouter.TrySetSelectedGroqModel(requestedModel))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"invalid model id\"}", cancellationToken);
                return true;
            }

            await WebSocketGateway.SendTextAsync(
                socket,
                sendLock,
                $"{{\"type\":\"groq_model_set\",\"ok\":true,\"model\":\"{WebSocketGateway.EscapeJson(requestedModel)}\"}}",
                cancellationToken
            );
            await _sendGroqModelsAsync(socket, sendLock, cancellationToken);
            return true;
        }

        return false;
    }

    private static bool IsSettingsOperationSuccess(string? result)
    {
        var normalized = (result ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        return !normalized.Contains("failed", StringComparison.OrdinalIgnoreCase)
            && !normalized.Contains("not set", StringComparison.OrdinalIgnoreCase);
    }
}
