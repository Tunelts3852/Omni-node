namespace OmniNode.Middleware;

public sealed class ContextApplicationService : IContextApplicationService
{
    private readonly CommandService _inner;

    public ContextApplicationService(CommandService inner)
    {
        _inner = inner;
    }

    public Task<ProjectContextSnapshot> ScanProjectContextAsync(CancellationToken cancellationToken)
    {
        return _inner.ScanProjectContextAsync(cancellationToken);
    }

    public Task<SkillManifestListResult> ListSkillsAsync(CancellationToken cancellationToken)
    {
        return _inner.ListSkillsAsync(cancellationToken);
    }

    public Task<CommandTemplateListResult> ListCommandsAsync(CancellationToken cancellationToken)
    {
        return _inner.ListCommandsAsync(cancellationToken);
    }
}
