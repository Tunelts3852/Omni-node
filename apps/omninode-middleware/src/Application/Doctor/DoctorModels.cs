using System.Text.Json.Serialization;

namespace OmniNode.Middleware;

[JsonConverter(typeof(JsonStringEnumConverter<DoctorStatus>))]
public enum DoctorStatus
{
    Ok,
    Warn,
    Fail,
    Skip
}

public sealed record DoctorCheckResult(
    string Id,
    DoctorStatus Status,
    string Summary,
    string? Detail,
    IReadOnlyList<string> SuggestedActions
);

public sealed record DoctorReport(
    string ReportId,
    DateTimeOffset CreatedAtUtc,
    IReadOnlyList<DoctorCheckResult> Checks,
    int OkCount,
    int WarnCount,
    int FailCount,
    int SkipCount
);
