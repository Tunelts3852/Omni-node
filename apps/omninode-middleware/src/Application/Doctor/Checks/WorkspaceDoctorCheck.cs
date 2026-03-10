namespace OmniNode.Middleware;

public sealed class WorkspaceDoctorCheck : IDoctorCheck
{
    private readonly AppConfig _config;
    private readonly IStatePathResolver _pathResolver;

    public WorkspaceDoctorCheck(AppConfig config, IStatePathResolver pathResolver)
    {
        _config = config;
        _pathResolver = pathResolver;
    }

    public string Id => "workspace";

    public async Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        var workspaceRoot = _config.WorkspaceRootDir;
        var workspaceEnv = Environment.GetEnvironmentVariable("OMNINODE_WORKSPACE_ROOT");
        if (!Directory.Exists(workspaceRoot))
        {
            return new DoctorCheckResult(
                Id,
                DoctorStatus.Fail,
                "워크스페이스 루트를 찾을 수 없습니다.",
                $"workspace={workspaceRoot}; env={(string.IsNullOrWhiteSpace(workspaceEnv) ? "auto" : workspaceEnv)}",
                new[] { "OMNINODE_WORKSPACE_ROOT를 올바른 canonical 경로로 설정하세요.", "`workspace/coding` 경로가 실제로 존재하는지 확인하세요." }
            );
        }

        var workspaceProbe = await TryProbeAsync(
            Path.Combine(Directory.GetParent(workspaceRoot)?.FullName ?? workspaceRoot, ".runtime", "doctor"),
            "workspace",
            cancellationToken
        );
        var stateProbe = await TryProbeAsync(_pathResolver.GetDoctorRoot(), "state", cancellationToken);
        var status = workspaceProbe.Ok && stateProbe.Ok ? DoctorStatus.Ok : DoctorStatus.Fail;

        return new DoctorCheckResult(
            Id,
            status,
            status == DoctorStatus.Ok
                ? "워크스페이스와 상태 루트에 접근할 수 있습니다."
                : "워크스페이스 또는 상태 루트 접근이 실패했습니다.",
            $"workspace={workspaceRoot}; env={(string.IsNullOrWhiteSpace(workspaceEnv) ? "auto" : workspaceEnv)}; workspaceProbe={workspaceProbe.Detail}; stateRoot={_pathResolver.StateRootDir}; stateProbe={stateProbe.Detail}",
            status == DoctorStatus.Ok
                ? Array.Empty<string>()
                : new[] { "워크스페이스와 `~/.omninode`의 쓰기 권한을 확인하세요.", "상태 루트가 다른 파일시스템 정책에 막히지 않았는지 확인하세요." }
        );
    }

    private static async Task<(bool Ok, string Detail)> TryProbeAsync(
        string directoryPath,
        string label,
        CancellationToken cancellationToken
    )
    {
        try
        {
            Directory.CreateDirectory(directoryPath);
            var probePath = Path.Combine(directoryPath, $"doctor-probe-{Guid.NewGuid():N}.tmp");
            await File.WriteAllTextAsync(probePath, "ok", cancellationToken);
            File.Delete(probePath);
            return (true, $"{label}=ok:{directoryPath}");
        }
        catch (Exception ex)
        {
            return (false, $"{label}=fail:{directoryPath}:{DoctorSupport.Trim(ex.Message, 180)}");
        }
    }
}
