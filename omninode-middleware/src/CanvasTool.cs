namespace OmniNode.Middleware;

public sealed record CanvasToolSnapshot(
    string SnapshotId,
    string Format,
    int Width,
    int Height,
    long UpdatedAtMs
);

public sealed record CanvasToolResult(
    bool Ok,
    string Action,
    string Profile,
    bool Disabled,
    string Adapter,
    bool Visible,
    string? Target,
    string? Url,
    string? EvalResult,
    CanvasToolSnapshot? Snapshot,
    int A2UiRevision,
    long UpdatedAtMs,
    string? Error
);

public sealed class CanvasTool
{
    private const string DefaultProfile = "default";
    private const int DefaultSnapshotWidth = 1280;
    private const int MaxSnapshotWidth = 4096;

    private readonly string _mode;
    private readonly object _lock = new();
    private readonly Dictionary<string, CanvasProfileState> _profiles = new(StringComparer.OrdinalIgnoreCase);

    public CanvasTool(AppConfig config)
    {
        _ = config;
        _mode = ResolveMode(Environment.GetEnvironmentVariable("OMNINODE_CANVAS_TOOL_MODE"));
    }

    public CanvasToolResult Execute(
        string? action,
        string? profile = null,
        string? target = null,
        string? targetUrl = null,
        string? javaScript = null,
        string? jsonl = null,
        string? outputFormat = null,
        int? maxWidth = null
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
            return new CanvasToolResult(
                Ok: false,
                Action: normalizedAction,
                Profile: resolvedProfile,
                Disabled: true,
                Adapter: "disabled",
                Visible: false,
                Target: null,
                Url: null,
                EvalResult: null,
                Snapshot: null,
                A2UiRevision: 0,
                UpdatedAtMs: UtcNowMs(),
                Error: "canvas tool disabled (OMNINODE_CANVAS_TOOL_MODE=off)"
            );
        }

        lock (_lock)
        {
            var state = GetOrCreateState(resolvedProfile);
            switch (normalizedAction)
            {
                case "status":
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                case "present":
                {
                    var resolvedTarget = ResolveTarget(target, targetUrl);
                    if (resolvedTarget is null)
                    {
                        return ErrorResult("target or url is required", normalizedAction, resolvedProfile, state);
                    }

                    state.Visible = true;
                    state.Target = resolvedTarget;
                    var normalizedUrl = NormalizeUrl(resolvedTarget);
                    if (!string.IsNullOrWhiteSpace(normalizedUrl))
                    {
                        state.Url = normalizedUrl;
                    }
                    else if (string.IsNullOrWhiteSpace(state.Url))
                    {
                        state.Url = "about:blank";
                    }

                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "hide":
                    state.Visible = false;
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                case "navigate":
                {
                    var normalizedUrl = NormalizeUrl(targetUrl) ?? NormalizeUrl(target);
                    if (normalizedUrl is null)
                    {
                        return ErrorResult("url is required and must use http/https or about:blank", normalizedAction, resolvedProfile, state);
                    }

                    state.Visible = true;
                    state.Target = normalizedUrl;
                    state.Url = normalizedUrl;
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "eval":
                {
                    var script = NormalizeText(javaScript);
                    if (script is null)
                    {
                        return ErrorResult("javaScript is required", normalizedAction, resolvedProfile, state);
                    }

                    state.LastEvalResult = BuildEvalPreview(script);
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "snapshot":
                {
                    var now = UtcNowMs();
                    var width = ResolveSnapshotWidth(maxWidth);
                    var height = ResolveSnapshotHeight(width);
                    state.LastSnapshot = new CanvasSnapshotState
                    {
                        SnapshotId = $"snapshot-{state.NextSnapshotNumber:D3}",
                        Format = NormalizeSnapshotFormat(outputFormat),
                        Width = width,
                        Height = height,
                        UpdatedAtMs = now
                    };
                    state.NextSnapshotNumber++;
                    state.UpdatedAtMs = now;
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "a2ui_push":
                {
                    var normalizedJsonl = NormalizeText(jsonl);
                    if (normalizedJsonl is null)
                    {
                        return ErrorResult("jsonl is required", normalizedAction, resolvedProfile, state);
                    }

                    _ = normalizedJsonl;
                    state.A2UiRevision++;
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                }
                case "a2ui_reset":
                    state.A2UiRevision = 0;
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null);
                default:
                    return ErrorResult(
                        $"unsupported canvas action: {normalizedAction}",
                        normalizedAction,
                        resolvedProfile,
                        state
                    );
            }
        }
    }

    private CanvasToolResult ErrorResult(
        string error,
        string action,
        string profile,
        CanvasProfileState? state
    )
    {
        if (state is null)
        {
            return new CanvasToolResult(
                Ok: false,
                Action: action,
                Profile: profile,
                Disabled: false,
                Adapter: _mode,
                Visible: false,
                Target: null,
                Url: null,
                EvalResult: null,
                Snapshot: null,
                A2UiRevision: 0,
                UpdatedAtMs: UtcNowMs(),
                Error: error
            );
        }

        return BuildSnapshot(state, action, profile, ok: false, error);
    }

    private CanvasToolResult BuildSnapshot(
        CanvasProfileState state,
        string action,
        string profile,
        bool ok,
        string? error
    )
    {
        CanvasToolSnapshot? snapshot = null;
        if (state.LastSnapshot is not null)
        {
            snapshot = new CanvasToolSnapshot(
                SnapshotId: state.LastSnapshot.SnapshotId,
                Format: state.LastSnapshot.Format,
                Width: state.LastSnapshot.Width,
                Height: state.LastSnapshot.Height,
                UpdatedAtMs: state.LastSnapshot.UpdatedAtMs
            );
        }

        return new CanvasToolResult(
            Ok: ok,
            Action: action,
            Profile: profile,
            Disabled: false,
            Adapter: _mode,
            Visible: state.Visible,
            Target: state.Target,
            Url: state.Url,
            EvalResult: state.LastEvalResult,
            Snapshot: snapshot,
            A2UiRevision: state.A2UiRevision,
            UpdatedAtMs: state.UpdatedAtMs,
            Error: error
        );
    }

    private CanvasProfileState GetOrCreateState(string profile)
    {
        if (_profiles.TryGetValue(profile, out var existing))
        {
            return existing;
        }

        var created = new CanvasProfileState
        {
            Visible = false,
            UpdatedAtMs = UtcNowMs(),
            NextSnapshotNumber = 1
        };
        _profiles[profile] = created;
        return created;
    }

    private static string? ResolveTarget(string? target, string? targetUrl)
    {
        return NormalizeText(target) ?? NormalizeText(targetUrl);
    }

    private static string? NormalizeUrl(string? url)
    {
        var candidate = NormalizeText(url);
        if (candidate is null)
        {
            return null;
        }

        if (string.Equals(candidate, "about:blank", StringComparison.OrdinalIgnoreCase))
        {
            return "about:blank";
        }

        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var parsed))
        {
            return null;
        }

        if (!string.Equals(parsed.Scheme, "http", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(parsed.Scheme, "https", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return parsed.AbsoluteUri;
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

    private static int ResolveSnapshotWidth(int? maxWidth)
    {
        if (!maxWidth.HasValue || maxWidth.Value <= 0)
        {
            return DefaultSnapshotWidth;
        }

        return Math.Clamp(maxWidth.Value, 320, MaxSnapshotWidth);
    }

    private static int ResolveSnapshotHeight(int width)
    {
        var estimated = (int)Math.Round(width * 9.0 / 16.0);
        return Math.Clamp(estimated, 180, 2160);
    }

    private static string NormalizeSnapshotFormat(string? outputFormat)
    {
        var normalized = NormalizeToken(outputFormat);
        return normalized switch
        {
            "jpg" => "jpeg",
            "jpeg" => "jpeg",
            _ => "png"
        };
    }

    private static string BuildEvalPreview(string javaScript)
    {
        var compact = javaScript
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Replace('\t', ' ')
            .Trim();
        while (compact.Contains("  ", StringComparison.Ordinal))
        {
            compact = compact.Replace("  ", " ", StringComparison.Ordinal);
        }

        if (compact.Length > 160)
        {
            compact = compact[..160] + "...";
        }

        return $"stub-eval:{compact}";
    }

    private static string ResolveProfile(string? profile)
    {
        var normalized = NormalizeToken(profile);
        return string.IsNullOrWhiteSpace(normalized) ? DefaultProfile : normalized;
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

    private sealed class CanvasProfileState
    {
        public bool Visible { get; set; }
        public string? Target { get; set; }
        public string? Url { get; set; }
        public string? LastEvalResult { get; set; }
        public CanvasSnapshotState? LastSnapshot { get; set; }
        public int A2UiRevision { get; set; }
        public int NextSnapshotNumber { get; set; }
        public long UpdatedAtMs { get; set; }
    }

    private sealed class CanvasSnapshotState
    {
        public string SnapshotId { get; set; } = string.Empty;
        public string Format { get; set; } = string.Empty;
        public int Width { get; set; }
        public int Height { get; set; }
        public long UpdatedAtMs { get; set; }
    }
}
