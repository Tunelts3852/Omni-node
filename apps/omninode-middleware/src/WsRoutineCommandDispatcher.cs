using System.Net.WebSockets;

namespace OmniNode.Middleware;

internal sealed class WsRoutineCommandDispatcher
{
    internal delegate Task SendRoutinesDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    );

    internal delegate Task SendRoutineActionResultDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        RoutineActionResult result,
        CancellationToken cancellationToken
    );

    internal delegate Task SendRoutineRunDetailDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        RoutineRunDetailResult result,
        CancellationToken cancellationToken
    );

    private readonly IRoutineApplicationService _routineService;
    private readonly SendRoutinesDelegate _sendRoutinesAsync;
    private readonly SendRoutineActionResultDelegate _sendRoutineActionResultAsync;
    private readonly SendRoutineRunDetailDelegate _sendRoutineRunDetailAsync;

    public WsRoutineCommandDispatcher(
        IRoutineApplicationService routineService,
        SendRoutinesDelegate sendRoutinesAsync,
        SendRoutineActionResultDelegate sendRoutineActionResultAsync,
        SendRoutineRunDetailDelegate sendRoutineRunDetailAsync
    )
    {
        _routineService = routineService;
        _sendRoutinesAsync = sendRoutinesAsync;
        _sendRoutineActionResultAsync = sendRoutineActionResultAsync;
        _sendRoutineRunDetailAsync = sendRoutineRunDetailAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "get_routines")
        {
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "create_routine")
        {
            if (string.IsNullOrWhiteSpace(message.Text))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routine request is required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.CreateRoutineAsync(
                message.Text.Trim(),
                message.Title,
                message.ExecutionMode,
                message.AgentProvider,
                message.AgentModel,
                message.AgentStartUrl,
                message.AgentTimeoutSeconds,
                message.AgentUsePlaywright,
                message.ScheduleSourceMode,
                message.MaxRetries,
                message.RetryDelaySeconds,
                message.NotifyPolicy,
                message.ScheduleKind,
                message.ScheduleTime,
                message.Weekdays,
                message.DayOfMonth,
                message.TimezoneId,
                "web",
                cancellationToken
            );
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "update_routine")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            if (string.IsNullOrWhiteSpace(message.Text))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routine request is required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.UpdateRoutineAsync(
                message.RoutineId.Trim(),
                message.Text.Trim(),
                message.Title,
                message.ExecutionMode,
                message.AgentProvider,
                message.AgentModel,
                message.AgentStartUrl,
                message.AgentTimeoutSeconds,
                message.AgentUsePlaywright,
                message.ScheduleSourceMode,
                message.MaxRetries,
                message.RetryDelaySeconds,
                message.NotifyPolicy,
                message.ScheduleKind,
                message.ScheduleTime,
                message.Weekdays,
                message.DayOfMonth,
                message.TimezoneId,
                cancellationToken
            );
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "run_routine")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.RunRoutineNowAsync(message.RoutineId.Trim(), "web", cancellationToken);
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "test_routine_telegram")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.RunRoutineNowAsync(message.RoutineId.Trim(), "telegram_test", cancellationToken);
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "test_browser_agent_routine")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.RunRoutineNowAsync(message.RoutineId.Trim(), "browser_agent_test", cancellationToken);
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "get_routine_run_detail")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId) || !message.Timestamp.HasValue)
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId and ts are required\"}", cancellationToken);
                return true;
            }

            var detail = _routineService.GetRoutineRunDetail(message.RoutineId.Trim(), message.Timestamp.Value);
            await _sendRoutineRunDetailAsync(socket, sendLock, detail, cancellationToken);
            return true;
        }

        if (message.Type == "resend_routine_run_telegram")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId) || !message.Timestamp.HasValue)
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId and ts are required\"}", cancellationToken);
                return true;
            }

            var result = await _routineService.ResendRoutineRunToTelegramAsync(
                message.RoutineId.Trim(),
                message.Timestamp.Value,
                cancellationToken
            );
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "toggle_routine")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            if (message.Enabled == null)
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"enabled is required\"}", cancellationToken);
                return true;
            }

            var result = _routineService.SetRoutineEnabled(message.RoutineId.Trim(), message.Enabled.Value);
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        if (message.Type == "delete_routine")
        {
            if (string.IsNullOrWhiteSpace(message.RoutineId))
            {
                await WebSocketGateway.SendTextAsync(socket, sendLock, "{\"type\":\"error\",\"message\":\"routineId is required\"}", cancellationToken);
                return true;
            }

            var result = _routineService.DeleteRoutine(message.RoutineId.Trim());
            await _sendRoutineActionResultAsync(socket, sendLock, result, cancellationToken);
            await _sendRoutinesAsync(socket, sendLock, cancellationToken);
            return true;
        }

        return false;
    }
}
