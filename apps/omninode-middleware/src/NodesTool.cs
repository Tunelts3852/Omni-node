using System.Text.Json;

namespace OmniNode.Middleware;

public sealed record NodesToolNode(
    string NodeId,
    string Label,
    bool Online,
    string Platform,
    IReadOnlyList<string> Commands,
    string? LastCommand,
    long? LastCommandAtMs,
    long UpdatedAtMs
);

public sealed record NodesToolPairingRequest(
    string RequestId,
    string NodeLabel,
    string Status,
    long RequestedAtMs,
    long UpdatedAtMs
);

public sealed record NodesToolResult(
    bool Ok,
    string Action,
    string Profile,
    bool Disabled,
    string Adapter,
    IReadOnlyList<NodesToolNode> Nodes,
    IReadOnlyList<NodesToolPairingRequest> PendingRequests,
    string? SelectedNodeId,
    string? SelectedCommand,
    string? InvokePayloadJson,
    long UpdatedAtMs,
    string? Error
);

public sealed class NodesTool
{
    private const string DefaultProfile = "default";
    private static readonly string[] DefaultNodeCommands =
    {
        "system.notify",
        "device.status",
        "app.echo"
    };

    private readonly string _mode;
    private readonly object _lock = new();
    private readonly Dictionary<string, NodesProfileState> _profiles = new(StringComparer.OrdinalIgnoreCase);

    public NodesTool(AppConfig config)
    {
        _ = config;
        _mode = ResolveMode(Environment.GetEnvironmentVariable("OMNINODE_NODES_TOOL_MODE"));
    }

    public NodesToolResult Execute(
        string? action,
        string? profile = null,
        string? node = null,
        string? requestId = null,
        string? title = null,
        string? body = null,
        string? priority = null,
        string? delivery = null,
        string? invokeCommand = null,
        string? invokeParamsJson = null
    )
    {
        var normalizedAction = NormalizeToken(action);
        var resolvedProfile = ResolveProfile(profile);
        if (string.IsNullOrWhiteSpace(normalizedAction))
        {
            return ErrorResult("action is required", "unknown", resolvedProfile, null);
        }

        if (string.Equals(_mode, "off", StringComparison.Ordinal))
        {
            return new NodesToolResult(
                Ok: false,
                Action: normalizedAction,
                Profile: resolvedProfile,
                Disabled: true,
                Adapter: "disabled",
                Nodes: Array.Empty<NodesToolNode>(),
                PendingRequests: Array.Empty<NodesToolPairingRequest>(),
                SelectedNodeId: null,
                SelectedCommand: null,
                InvokePayloadJson: null,
                UpdatedAtMs: UtcNowMs(),
                Error: "nodes tool disabled (OMNINODE_NODES_TOOL_MODE=off)"
            );
        }

        lock (_lock)
        {
            var state = GetOrCreateState(resolvedProfile);
            switch (normalizedAction)
            {
                case "status":
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                case "describe":
                {
                    var resolvedNode = ResolveNode(state, node);
                    if (resolvedNode is null)
                    {
                        return ErrorResult("node is required and must match nodeId or label", normalizedAction, resolvedProfile, state);
                    }

                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(
                        state,
                        normalizedAction,
                        resolvedProfile,
                        ok: true,
                        error: null,
                        selectedNodeId: resolvedNode.NodeId
                    );
                }
                case "pending":
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                case "approve":
                {
                    var normalizedRequestId = NormalizeText(requestId);
                    if (normalizedRequestId is null)
                    {
                        return ErrorResult("requestId is required", normalizedAction, resolvedProfile, state);
                    }

                    var pending = state.PendingRequests
                        .FirstOrDefault(x => x.RequestId.Equals(normalizedRequestId, StringComparison.OrdinalIgnoreCase));
                    if (pending is null)
                    {
                        return ErrorResult($"pending request not found: {normalizedRequestId}", normalizedAction, resolvedProfile, state);
                    }

                    _ = state.PendingRequests.Remove(pending);
                    pending.Status = "approved";
                    pending.UpdatedAtMs = UtcNowMs();
                    var pairedNode = EnsurePairedNode(state, pending.NodeLabel);
                    state.UpdatedAtMs = pending.UpdatedAtMs;

                    return BuildSnapshot(
                        state,
                        normalizedAction,
                        resolvedProfile,
                        ok: true,
                        error: null,
                        selectedNodeId: pairedNode.NodeId
                    );
                }
                case "reject":
                {
                    var normalizedRequestId = NormalizeText(requestId);
                    if (normalizedRequestId is null)
                    {
                        return ErrorResult("requestId is required", normalizedAction, resolvedProfile, state);
                    }

                    var pending = state.PendingRequests
                        .FirstOrDefault(x => x.RequestId.Equals(normalizedRequestId, StringComparison.OrdinalIgnoreCase));
                    if (pending is null)
                    {
                        return ErrorResult($"pending request not found: {normalizedRequestId}", normalizedAction, resolvedProfile, state);
                    }

                    _ = state.PendingRequests.Remove(pending);
                    pending.Status = "rejected";
                    pending.UpdatedAtMs = UtcNowMs();
                    state.UpdatedAtMs = pending.UpdatedAtMs;
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "notify":
                {
                    var resolvedNode = ResolveNode(state, node);
                    if (resolvedNode is null)
                    {
                        return ErrorResult("node is required and must match nodeId or label", normalizedAction, resolvedProfile, state);
                    }

                    var normalizedTitle = NormalizeText(title);
                    var normalizedBody = NormalizeText(body);
                    if (normalizedTitle is null && normalizedBody is null)
                    {
                        return ErrorResult("title or body is required", normalizedAction, resolvedProfile, state);
                    }

                    var normalizedPriority = NormalizePriority(priority);
                    if (normalizedPriority is null && NormalizeText(priority) is not null)
                    {
                        return ErrorResult("priority must be one of: passive, active, timeSensitive", normalizedAction, resolvedProfile, state);
                    }

                    var normalizedDelivery = NormalizeDelivery(delivery);
                    if (normalizedDelivery is null && NormalizeText(delivery) is not null)
                    {
                        return ErrorResult("delivery must be one of: system, overlay, auto", normalizedAction, resolvedProfile, state);
                    }

                    _ = normalizedPriority;
                    _ = normalizedDelivery;
                    resolvedNode.LastCommand = "system.notify";
                    resolvedNode.LastCommandAtMs = UtcNowMs();
                    resolvedNode.UpdatedAtMs = resolvedNode.LastCommandAtMs.Value;
                    state.UpdatedAtMs = resolvedNode.UpdatedAtMs;
                    return BuildSnapshot(
                        state,
                        normalizedAction,
                        resolvedProfile,
                        ok: true,
                        error: null,
                        selectedNodeId: resolvedNode.NodeId,
                        selectedCommand: "system.notify"
                    );
                }
                case "invoke":
                {
                    var resolvedNode = ResolveNode(state, node);
                    if (resolvedNode is null)
                    {
                        return ErrorResult("node is required and must match nodeId or label", normalizedAction, resolvedProfile, state);
                    }

                    var normalizedCommand = NormalizeText(invokeCommand);
                    if (normalizedCommand is null)
                    {
                        return ErrorResult("invokeCommand is required", normalizedAction, resolvedProfile, state);
                    }

                    var normalizedPayload = NormalizeInvokePayload(invokeParamsJson, out var payloadError);
                    if (payloadError is not null)
                    {
                        return ErrorResult(payloadError, normalizedAction, resolvedProfile, state);
                    }

                    resolvedNode.LastCommand = normalizedCommand;
                    resolvedNode.LastCommandAtMs = UtcNowMs();
                    resolvedNode.UpdatedAtMs = resolvedNode.LastCommandAtMs.Value;
                    state.LastInvokePayloadJson = normalizedPayload;
                    state.UpdatedAtMs = resolvedNode.UpdatedAtMs;
                    return BuildSnapshot(
                        state,
                        normalizedAction,
                        resolvedProfile,
                        ok: true,
                        error: null,
                        selectedNodeId: resolvedNode.NodeId,
                        selectedCommand: normalizedCommand,
                        invokePayloadJson: normalizedPayload
                    );
                }
                default:
                    return ErrorResult(
                        $"unsupported nodes action: {normalizedAction}",
                        normalizedAction,
                        resolvedProfile,
                        state
                    );
            }
        }
    }

    private NodesToolResult ErrorResult(
        string error,
        string action,
        string profile,
        NodesProfileState? state
    )
    {
        if (state is null)
        {
            return new NodesToolResult(
                Ok: false,
                Action: action,
                Profile: profile,
                Disabled: false,
                Adapter: _mode,
                Nodes: Array.Empty<NodesToolNode>(),
                PendingRequests: Array.Empty<NodesToolPairingRequest>(),
                SelectedNodeId: null,
                SelectedCommand: null,
                InvokePayloadJson: null,
                UpdatedAtMs: UtcNowMs(),
                Error: error
            );
        }

        return BuildSnapshot(state, action, profile, ok: false, error);
    }

    private NodesToolResult BuildSnapshot(
        NodesProfileState state,
        string action,
        string profile,
        bool ok,
        string? error,
        string? selectedNodeId = null,
        string? selectedCommand = null,
        string? invokePayloadJson = null
    )
    {
        var nodes = state.Nodes
            .OrderByDescending(x => x.Online)
            .ThenBy(x => x.NodeId, StringComparer.OrdinalIgnoreCase)
            .Select(x => new NodesToolNode(
                NodeId: x.NodeId,
                Label: x.Label,
                Online: x.Online,
                Platform: x.Platform,
                Commands: x.Commands.ToArray(),
                LastCommand: x.LastCommand,
                LastCommandAtMs: x.LastCommandAtMs,
                UpdatedAtMs: x.UpdatedAtMs
            ))
            .ToArray();

        var pendingRequests = state.PendingRequests
            .OrderByDescending(x => x.UpdatedAtMs)
            .ThenBy(x => x.RequestId, StringComparer.OrdinalIgnoreCase)
            .Select(x => new NodesToolPairingRequest(
                RequestId: x.RequestId,
                NodeLabel: x.NodeLabel,
                Status: x.Status,
                RequestedAtMs: x.RequestedAtMs,
                UpdatedAtMs: x.UpdatedAtMs
            ))
            .ToArray();

        return new NodesToolResult(
            Ok: ok,
            Action: action,
            Profile: profile,
            Disabled: false,
            Adapter: _mode,
            Nodes: nodes,
            PendingRequests: pendingRequests,
            SelectedNodeId: selectedNodeId,
            SelectedCommand: selectedCommand,
            InvokePayloadJson: invokePayloadJson,
            UpdatedAtMs: state.UpdatedAtMs,
            Error: error
        );
    }

    private NodesProfileState GetOrCreateState(string profile)
    {
        if (_profiles.TryGetValue(profile, out var existing))
        {
            return existing;
        }

        var now = UtcNowMs();
        var created = new NodesProfileState
        {
            UpdatedAtMs = now
        };
        created.Nodes.Add(new NodeState
        {
            NodeId = "node-001",
            Label = "local-node",
            Online = true,
            Platform = "stub-macos",
            Commands = DefaultNodeCommands.ToList(),
            UpdatedAtMs = now
        });
        created.PendingRequests.Add(new PairingRequestState
        {
            RequestId = "pair-001",
            NodeLabel = "pending-node-001",
            Status = "pending",
            RequestedAtMs = now,
            UpdatedAtMs = now
        });
        _profiles[profile] = created;
        return created;
    }

    private static NodeState? ResolveNode(NodesProfileState state, string? node)
    {
        var candidate = NormalizeText(node);
        if (candidate is null)
        {
            return null;
        }

        return state.Nodes.FirstOrDefault(x =>
            x.NodeId.Equals(candidate, StringComparison.OrdinalIgnoreCase)
            || x.Label.Equals(candidate, StringComparison.OrdinalIgnoreCase));
    }

    private static NodeState EnsurePairedNode(NodesProfileState state, string nodeLabel)
    {
        var existing = state.Nodes.FirstOrDefault(x =>
            x.Label.Equals(nodeLabel, StringComparison.OrdinalIgnoreCase));
        if (existing is not null)
        {
            existing.Online = true;
            existing.UpdatedAtMs = UtcNowMs();
            return existing;
        }

        var now = UtcNowMs();
        var created = new NodeState
        {
            NodeId = $"node-{state.NextNodeNumber:D3}",
            Label = nodeLabel,
            Online = true,
            Platform = "stub-ios",
            Commands = DefaultNodeCommands.ToList(),
            UpdatedAtMs = now
        };
        state.NextNodeNumber++;
        state.Nodes.Add(created);
        return created;
    }

    private static string? NormalizeInvokePayload(string? invokeParamsJson, out string? error)
    {
        error = null;
        var candidate = NormalizeText(invokeParamsJson);
        if (candidate is null)
        {
            return "{}";
        }

        try
        {
            using var doc = JsonDocument.Parse(candidate);
            return doc.RootElement.GetRawText();
        }
        catch (JsonException ex)
        {
            error = $"invokeParamsJson must be valid JSON: {ex.Message}";
            return null;
        }
    }

    private static string? NormalizePriority(string? priority)
    {
        var normalized = NormalizeToken(priority);
        return normalized switch
        {
            "passive" => "passive",
            "active" => "active",
            "timesensitive" => "timeSensitive",
            _ => null
        };
    }

    private static string? NormalizeDelivery(string? delivery)
    {
        var normalized = NormalizeToken(delivery);
        return normalized switch
        {
            "system" => "system",
            "overlay" => "overlay",
            "auto" => "auto",
            _ => null
        };
    }

    private static string ResolveProfile(string? profile)
    {
        var normalized = NormalizeToken(profile);
        return string.IsNullOrWhiteSpace(normalized) ? DefaultProfile : normalized;
    }

    private static string? NormalizeText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
    }

    private static string NormalizeToken(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : value.Trim().ToLowerInvariant();
    }

    private static string ResolveMode(string? mode)
    {
        var normalized = NormalizeToken(mode);
        return normalized switch
        {
            "off" => "off",
            "stub" => "stub",
            _ => "stub"
        };
    }

    private static long UtcNowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private sealed class NodesProfileState
    {
        public List<NodeState> Nodes { get; } = new();
        public List<PairingRequestState> PendingRequests { get; } = new();
        public string? LastInvokePayloadJson { get; set; }
        public int NextNodeNumber { get; set; } = 2;
        public long UpdatedAtMs { get; set; }
    }

    private sealed class NodeState
    {
        public string NodeId { get; set; } = string.Empty;
        public string Label { get; set; } = string.Empty;
        public bool Online { get; set; }
        public string Platform { get; set; } = string.Empty;
        public List<string> Commands { get; set; } = new();
        public string? LastCommand { get; set; }
        public long? LastCommandAtMs { get; set; }
        public long UpdatedAtMs { get; set; }
    }

    private sealed class PairingRequestState
    {
        public string RequestId { get; set; } = string.Empty;
        public string NodeLabel { get; set; } = string.Empty;
        public string Status { get; set; } = "pending";
        public long RequestedAtMs { get; set; }
        public long UpdatedAtMs { get; set; }
    }
}
