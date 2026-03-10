namespace OmniNode.Middleware;

public sealed class FileDoctorReportStore
{
    private readonly IStatePathResolver _pathResolver;

    public FileDoctorReportStore(IStatePathResolver pathResolver)
    {
        _pathResolver = pathResolver;
    }

    public DoctorReport? TryLoadLastReport()
    {
        var path = _pathResolver.GetDoctorLastReportPath();
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(path);
            return DoctorJson.DeserializeReport(json);
        }
        catch
        {
            return null;
        }
    }

    public void Save(DoctorReport report, bool writeHistory)
    {
        var lastReportPath = _pathResolver.GetDoctorLastReportPath();
        AtomicFileStore.WriteAllText(lastReportPath, DoctorJson.Serialize(report, indented: true));

        if (!writeHistory)
        {
            return;
        }

        var historyRoot = _pathResolver.GetDoctorHistoryRoot();
        var historyPath = Path.Combine(historyRoot, $"{report.CreatedAtUtc:yyyyMMdd-HHmmssfff}.json");
        AtomicFileStore.WriteAllText(historyPath, DoctorJson.Serialize(report, indented: true));
    }
}
