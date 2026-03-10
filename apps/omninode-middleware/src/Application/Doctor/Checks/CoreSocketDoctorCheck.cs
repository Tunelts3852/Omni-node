namespace OmniNode.Middleware;

public sealed class CoreSocketDoctorCheck : IDoctorCheck
{
    private readonly AppConfig _config;
    private readonly UdsCoreClient _coreClient;

    public CoreSocketDoctorCheck(AppConfig config, UdsCoreClient coreClient)
    {
        _config = config;
        _coreClient = coreClient;
    }

    public string Id => "core_socket";

    public async Task<DoctorCheckResult> RunAsync(CancellationToken cancellationToken)
    {
        var socketPath = _config.CoreSocketPath;
        var lockPath = DoctorSupport.ResolveCoreLockPath();
        var auditParent = Path.GetDirectoryName(_config.AuditLogPath) ?? "(none)";
        var socketExists = File.Exists(socketPath);
        var lockExists = File.Exists(lockPath);
        var auditParentExists = Directory.Exists(auditParent);

        if (!socketExists)
        {
            return new DoctorCheckResult(
                Id,
                DoctorStatus.Fail,
                "코어 UDS 소켓을 찾을 수 없습니다.",
                $"socket={socketPath}; lock={(lockExists ? "present" : "missing")}; auditParent={auditParent}({(auditParentExists ? "present" : "missing")})",
                new[] { "apps/omninode-core를 빌드하고 코어 프로세스를 다시 기동하세요.", "남아 있는 `/tmp/omninode*.sock` 또는 lock 파일 꼬임 여부를 점검하세요." }
            );
        }

        try
        {
            var metrics = await _coreClient.GetMetricsAsync(cancellationToken);
            var status = lockExists && auditParentExists
                ? DoctorStatus.Ok
                : DoctorStatus.Warn;
            var summary = status == DoctorStatus.Ok
                ? "코어 소켓 응답이 정상입니다."
                : "코어 소켓은 응답했지만 보조 경로 점검에 경고가 있습니다.";
            return new DoctorCheckResult(
                Id,
                status,
                summary,
                $"socket={socketPath}; lock={(lockExists ? "present" : "missing")}; auditParent={auditParent}({(auditParentExists ? "present" : "missing")}); metrics={DoctorSupport.Trim(metrics, 240)}",
                status == DoctorStatus.Ok
                    ? Array.Empty<string>()
                    : new[] { "코어 lock 파일과 감사 로그 부모 디렉터리 존재 여부를 점검하세요." }
            );
        }
        catch (Exception ex)
        {
            return new DoctorCheckResult(
                Id,
                DoctorStatus.Fail,
                "코어 소켓 연결에 실패했습니다.",
                $"socket={socketPath}; error={DoctorSupport.Trim(ex.Message, 280)}",
                new[] { "코어 프로세스가 실제로 실행 중인지 확인하세요.", "소켓 경로가 `OMNINODE_CORE_SOCKET_PATH`와 일치하는지 확인하세요." }
            );
        }
    }
}
