namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    public Task<DoctorReport> RunDoctorAsync(CancellationToken cancellationToken)
    {
        return _doctorService.RunAsync(cancellationToken);
    }

    public Task<DoctorReport?> GetLastDoctorReportAsync(CancellationToken cancellationToken)
    {
        return _doctorService.GetLastReportAsync(cancellationToken);
    }

    private async Task<string> ExecuteDoctorReportCommandAsync(
        bool json,
        bool latestOnly,
        CancellationToken cancellationToken
    )
    {
        var report = latestOnly
            ? await GetLastDoctorReportAsync(cancellationToken)
            : await RunDoctorAsync(cancellationToken);

        if (json)
        {
            return report == null ? "null" : DoctorJson.Serialize(report, indented: true);
        }

        return DoctorCli.RenderText(report);
    }
}
