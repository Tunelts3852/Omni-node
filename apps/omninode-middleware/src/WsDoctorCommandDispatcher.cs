using System.Net.WebSockets;

namespace OmniNode.Middleware;

internal sealed class WsDoctorCommandDispatcher
{
    internal delegate Task SendDoctorResultDelegate(
        WebSocket socket,
        SemaphoreSlim sendLock,
        string action,
        DoctorReport? report,
        bool found,
        CancellationToken cancellationToken
    );

    private readonly IDoctorApplicationService _doctorService;
    private readonly SendDoctorResultDelegate _sendDoctorResultAsync;

    public WsDoctorCommandDispatcher(
        IDoctorApplicationService doctorService,
        SendDoctorResultDelegate sendDoctorResultAsync
    )
    {
        _doctorService = doctorService;
        _sendDoctorResultAsync = sendDoctorResultAsync;
    }

    public async Task<bool> TryHandleAsync(
        WebSocketGateway.ClientMessage message,
        WebSocket socket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken
    )
    {
        if (message.Type == "doctor_run")
        {
            var report = await _doctorService.RunDoctorAsync(cancellationToken);
            await _sendDoctorResultAsync(socket, sendLock, "run", report, true, cancellationToken);
            return true;
        }

        if (message.Type == "doctor_get_last")
        {
            var report = await _doctorService.GetLastDoctorReportAsync(cancellationToken);
            await _sendDoctorResultAsync(socket, sendLock, "get_last", report, report != null, cancellationToken);
            return true;
        }

        return false;
    }
}
