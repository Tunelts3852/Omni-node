namespace OmniNode.Middleware;

public sealed class SqliteDoctorCheck : IDoctorCheck
{
    public string Id => "sqlite";

    public async Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await DoctorSupport.RunProcessAsync(
                "sqlite3",
                new[] { "--version" },
                cancellationToken
            );
            if (result.ExitCode != 0)
            {
                return new DoctorCheckResult(
                    Id,
                    DoctorStatus.Warn,
                    "sqlite3 명령 실행에 실패했습니다.",
                    DoctorSupport.Trim($"{result.StdErr} {result.StdOut}", 280),
                    new[] { "메모리 인덱스 기능이 필요하면 sqlite3를 설치하고 PATH를 확인하세요." }
                );
            }

            return new DoctorCheckResult(
                Id,
                DoctorStatus.Ok,
                "sqlite3 실행이 가능합니다.",
                DoctorSupport.Trim(result.StdOut, 200),
                Array.Empty<string>()
            );
        }
        catch (Exception ex)
        {
            return new DoctorCheckResult(
                Id,
                DoctorStatus.Warn,
                "sqlite3를 찾을 수 없습니다.",
                DoctorSupport.Trim(ex.Message, 240),
                new[] { "메모리 인덱스 초기화와 검색 점검을 위해 sqlite3를 설치하세요." }
            );
        }
    }
}
