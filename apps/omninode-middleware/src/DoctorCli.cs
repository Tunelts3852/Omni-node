using System.Text;

namespace OmniNode.Middleware;

internal static class DoctorCli
{
    public static async Task<bool> TryHandleAsync(
        string[] args,
        DoctorService doctorService,
        CancellationToken cancellationToken
    )
    {
        if (args.Length == 0 || !args[0].Equals("doctor", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var json = false;
        foreach (var arg in args.Skip(1))
        {
            if (arg.Equals("--json", StringComparison.OrdinalIgnoreCase))
            {
                json = true;
                continue;
            }

            Console.Error.WriteLine("사용법: dotnet run --project apps/omninode-middleware/OmniNode.Middleware.csproj -- doctor [--json]");
            Environment.ExitCode = 1;
            return true;
        }

        var report = await doctorService.RunAsync(cancellationToken);
        Console.WriteLine(json ? DoctorJson.Serialize(report, indented: true) : RenderText(report));
        return true;
    }

    public static string RenderText(DoctorReport? report)
    {
        if (report == null)
        {
            return "저장된 doctor 보고서가 없습니다.";
        }

        var builder = new StringBuilder();
        builder.AppendLine("[Omni-node Doctor]");
        builder.AppendLine($"report={report.ReportId}");
        builder.AppendLine($"createdAtUtc={report.CreatedAtUtc:O}");
        builder.AppendLine($"counts ok={report.OkCount} warn={report.WarnCount} fail={report.FailCount} skip={report.SkipCount}");
        foreach (var check in report.Checks)
        {
            builder.Append("- ");
            builder.Append(check.Status.ToString().ToLowerInvariant());
            builder.Append(' ');
            builder.Append(check.Id);
            builder.Append(": ");
            builder.AppendLine(check.Summary);
            if (!string.IsNullOrWhiteSpace(check.Detail))
            {
                builder.AppendLine($"  detail: {check.Detail}");
            }

            if (check.SuggestedActions.Count > 0)
            {
                builder.AppendLine($"  actions: {string.Join(" | ", check.SuggestedActions)}");
            }
        }

        return builder.ToString().TrimEnd();
    }
}
