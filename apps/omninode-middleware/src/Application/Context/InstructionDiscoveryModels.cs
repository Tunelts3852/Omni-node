namespace OmniNode.Middleware;

public sealed record InstructionSource(string Path, string Scope, int Order);

public sealed record InstructionBundle(
    IReadOnlyList<InstructionSource> Sources,
    string CombinedText
);

public sealed record SkillManifest(
    string Name,
    string Description,
    string Path,
    string Scope
);

public sealed record CommandTemplateInfo(
    string Name,
    string Summary,
    string Path,
    string Scope
);

public sealed record SkillManifestListResult(
    string ProjectRoot,
    string CurrentDirectory,
    IReadOnlyList<SkillManifest> Items,
    string ScannedAtUtc
);

public sealed record CommandTemplateListResult(
    string ProjectRoot,
    string CurrentDirectory,
    IReadOnlyList<CommandTemplateInfo> Items,
    string ScannedAtUtc
);

public sealed record ProjectContextSnapshot(
    string ProjectRoot,
    string CurrentDirectory,
    InstructionBundle Instructions,
    IReadOnlyList<SkillManifest> Skills,
    IReadOnlyList<CommandTemplateInfo> Commands,
    string ScannedAtUtc
);
