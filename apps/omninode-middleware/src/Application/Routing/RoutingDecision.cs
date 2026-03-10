namespace OmniNode.Middleware;

public sealed record RoutingDecision(
    string DecisionId,
    TaskCategory Category,
    string CategoryKey,
    string CategoryLabel,
    DateTimeOffset DecidedAtUtc,
    string RequestedProvider,
    string ResolvedProvider,
    IReadOnlyList<string> ProviderChain,
    IReadOnlyList<string> AvailableProviders,
    string Reason
);

public sealed record RoutingPolicySnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<string>> DefaultChains,
    IReadOnlyDictionary<string, IReadOnlyList<string>> OverrideChains,
    IReadOnlyDictionary<string, IReadOnlyList<string>> EffectiveChains,
    RoutingDecision? LastDecision
);

public sealed record RoutingPolicyActionResult(
    bool Ok,
    string Message,
    RoutingPolicySnapshot Snapshot
);
