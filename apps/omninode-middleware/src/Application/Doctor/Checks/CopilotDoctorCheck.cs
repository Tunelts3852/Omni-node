namespace OmniNode.Middleware;

public sealed class CopilotDoctorCheck : IDoctorCheck
{
    private readonly CopilotCliWrapper _copilotWrapper;

    public CopilotDoctorCheck(CopilotCliWrapper copilotWrapper)
    {
        _copilotWrapper = copilotWrapper;
    }

    public string Id => "copilot";

    public async Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        var status = await _copilotWrapper.GetStatusAsync(cancellationToken);
        var doctorStatus = status.Installed
            ? status.Authenticated ? DoctorStatus.Ok : DoctorStatus.Warn
            : DoctorStatus.Warn;

        var summary = doctorStatus switch
        {
            DoctorStatus.Ok => $"Copilot CLI가 준비되었습니다. mode={status.Mode}",
            _ when status.Installed => $"Copilot CLI는 설치되어 있지만 인증이 필요합니다. mode={status.Mode}",
            _ => "Copilot CLI를 찾을 수 없습니다."
        };

        var actions = new List<string>();
        if (!status.Installed)
        {
            actions.Add("Copilot 워크플로를 쓸 계획이면 `gh` 또는 `copilot` CLI 설치 여부를 확인하세요.");
        }
        else if (!status.Authenticated)
        {
            actions.Add("설정 탭 또는 `gh auth login`으로 인증을 완료하세요.");
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
