namespace OmniNode.Middleware;

public sealed class CodexDoctorCheck : IDoctorCheck
{
    private readonly CodexCliWrapper _codexWrapper;

    public CodexDoctorCheck(CodexCliWrapper codexWrapper)
    {
        _codexWrapper = codexWrapper;
    }

    public string Id => "codex";

    public async Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        var status = await _codexWrapper.GetStatusAsync(cancellationToken);
        var doctorStatus = status.Installed
            ? status.Authenticated ? DoctorStatus.Ok : DoctorStatus.Warn
            : DoctorStatus.Warn;

        var summary = doctorStatus switch
        {
            DoctorStatus.Ok => $"Codex CLI가 준비되었습니다. mode={status.Mode}",
            _ when status.Installed => $"Codex CLI는 설치되어 있지만 인증이 필요합니다. mode={status.Mode}",
            _ => "Codex CLI를 찾을 수 없습니다."
        };

        var actions = new List<string>();
        if (!status.Installed)
        {
            actions.Add("Codex 워크플로를 쓸 계획이면 `codex` CLI 설치 여부와 PATH를 확인하세요.");
        }
        else if (!status.Authenticated)
        {
            actions.Add("설정 탭의 Codex 로그인 흐름 또는 `codex login`으로 인증을 완료하세요.");
        }

        return new DoctorCheckResult(
            Id,
            doctorStatus,
            summary,
            DoctorSupport.Trim(status.Detail, 320),
            actions
        );
    }
}
