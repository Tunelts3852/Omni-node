namespace OmniNode.Middleware;

public sealed record BrowserToolTab(
    string TargetId,
    string Url,
    string Title,
    bool Active,
    long UpdatedAtMs
);

public sealed record BrowserToolResult(
    bool Ok,
    string Action,
    string Profile,
    bool Disabled,
    string Adapter,
    bool Running,
    string? ActiveTargetId,
    string? ActiveUrl,
    IReadOnlyList<BrowserToolTab> Tabs,
    string? Error
);

public sealed class BrowserTool
{
    private const int DefaultTabLimit = 20;
    private const int MaxTabLimit = 100;
    private const string DefaultProfile = "default";

    private readonly string _mode;
    private readonly object _lock = new();
    private readonly Dictionary<string, BrowserProfileState> _profiles = new(StringComparer.OrdinalIgnoreCase);

    public BrowserTool(AppConfig config)
    {
        _ = config;
        _mode = ResolveMode(Environment.GetEnvironmentVariable("OMNINODE_BROWSER_TOOL_MODE"));
    }

    public BrowserToolResult Execute(
        string? action,
        string? targetUrl = null,
        string? profile = null,
        string? targetId = null,
        int? limit = null
    )
    {
        var normalizedAction = NormalizeToken(action);
        var resolvedProfile = ResolveProfile(profile);
        var resolvedTargetId = NormalizeToken(targetId);
        var resolvedLimit = ResolveLimit(limit);

        if (string.IsNullOrWhiteSpace(normalizedAction))
        {
            return ErrorResult("action is required", "unknown", resolvedProfile, null, resolvedLimit);
        }

        if (string.Equals(_mode, "off", StringComparison.Ordinal))
        {
            return new BrowserToolResult(
                Ok: false,
                Action: normalizedAction,
                Profile: resolvedProfile,
                Disabled: true,
                Adapter: "disabled",
                Running: false,
                ActiveTargetId: null,
                ActiveUrl: null,
                Tabs: Array.Empty<BrowserToolTab>(),
                Error: "browser tool disabled (OMNINODE_BROWSER_TOOL_MODE=off)"
            );
        }

        lock (_lock)
        {
            var state = GetOrCreateState(resolvedProfile);
            switch (normalizedAction)
            {
                case "status":
                case "tabs":
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                case "start":
                    state.Running = true;
                    EnsureDefaultTab(state);
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                case "stop":
                    state.Running = false;
                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                case "navigate":
                {
                    var normalizedUrl = NormalizeUrl(targetUrl);
                    if (normalizedUrl is null)
                    {
                        return ErrorResult(
                            "url is required and must use http/https or about:blank",
                            normalizedAction,
                            resolvedProfile,
                            state,
                            resolvedLimit
                        );
                    }

                    state.Running = true;
                    var targetTab = ResolveNavigationTab(state, resolvedTargetId);
                    targetTab.Url = normalizedUrl;
                    targetTab.Title = BuildTitle(normalizedUrl);
                    targetTab.UpdatedAtMs = UtcNowMs();
                    state.ActiveTargetId = targetTab.TargetId;
                    state.UpdatedAtMs = targetTab.UpdatedAtMs;
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                }
                case "open":
                {
                    var normalizedUrl = NormalizeUrl(targetUrl);
                    if (normalizedUrl is null)
                    {
                        return ErrorResult(
                            "url is required and must use http/https or about:blank",
                            normalizedAction,
                            resolvedProfile,
                            state,
                            resolvedLimit
                        );
                    }

                    state.Running = true;
                    var opened = CreateTab(state, normalizedUrl);
                    state.ActiveTargetId = opened.TargetId;
                    state.UpdatedAtMs = opened.UpdatedAtMs;
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                }
                case "focus":
                {
                    if (string.IsNullOrWhiteSpace(resolvedTargetId))
                    {
                        return ErrorResult("targetId is required for focus", normalizedAction, resolvedProfile, state, resolvedLimit);
                    }

                    var target = state.Tabs.FirstOrDefault(x =>
                        x.TargetId.Equals(resolvedTargetId, StringComparison.OrdinalIgnoreCase));
                    if (target is null)
                    {
                        return ErrorResult("target tab not found", normalizedAction, resolvedProfile, state, resolvedLimit);
                    }

                    state.ActiveTargetId = target.TargetId;
                    target.UpdatedAtMs = UtcNowMs();
                    state.UpdatedAtMs = target.UpdatedAtMs;
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                }
                case "close":
                {
                    var target = ResolveClosableTab(state, resolvedTargetId);
                    if (target is null)
                    {
                        return ErrorResult("target tab not found", normalizedAction, resolvedProfile, state, resolvedLimit);
                    }

                    _ = state.Tabs.Remove(target);
                    if (state.Tabs.Count == 0)
                    {
                        state.ActiveTargetId = null;
                    }
                    else if (string.Equals(state.ActiveTargetId, target.TargetId, StringComparison.OrdinalIgnoreCase))
                    {
                        state.ActiveTargetId = state.Tabs[^1].TargetId;
                    }

                    state.UpdatedAtMs = UtcNowMs();
                    return BuildSnapshot(state, normalizedAction, resolvedProfile, ok: true, error: null, resolvedLimit);
                }
                default:
                    return ErrorResult(
                        $"unsupported browser action: {normalizedAction}",
                        normalizedAction,
                        resolvedProfile,
                        state,
                        resolvedLimit
                    );
            }
        }
    }

    private BrowserToolResult ErrorResult(
        string error,
        string action,
        string profile,
        BrowserProfileState? state,
        int limit
    )
    {
        if (state is null)
        {
            return new BrowserToolResult(
                Ok: false,
                Action: action,
                Profile: profile,
                Disabled: false,
                Adapter: _mode,
                Running: false,
                ActiveTargetId: null,
                ActiveUrl: null,
                Tabs: Array.Empty<BrowserToolTab>(),
                Error: error
            );
        }

        return BuildSnapshot(state, action, profile, ok: false, error, limit);
    }

    private BrowserToolResult BuildSnapshot(
        BrowserProfileState state,
        string action,
        string profile,
        bool ok,
        string? error,
        int limit
    )
    {
        var mappedTabs = state.Tabs
            .OrderByDescending(x => x.TargetId.Equals(state.ActiveTargetId, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(x => x.UpdatedAtMs)
            .Take(limit)
            .Select(x => new BrowserToolTab(
                TargetId: x.TargetId,
                Url: x.Url,
                Title: x.Title,
                Active: x.TargetId.Equals(state.ActiveTargetId, StringComparison.OrdinalIgnoreCase),
                UpdatedAtMs: x.UpdatedAtMs
            ))
            .ToArray();

        var activeUrl = state.Tabs
            .FirstOrDefault(x => x.TargetId.Equals(state.ActiveTargetId, StringComparison.OrdinalIgnoreCase))
            ?.Url;

        return new BrowserToolResult(
            Ok: ok,
            Action: action,
            Profile: profile,
            Disabled: false,
            Adapter: _mode,
            Running: state.Running,
            ActiveTargetId: state.ActiveTargetId,
            ActiveUrl: activeUrl,
            Tabs: mappedTabs,
            Error: error
        );
    }

    private BrowserProfileState GetOrCreateState(string profile)
    {
        if (_profiles.TryGetValue(profile, out var existing))
        {
            return existing;
        }

        var created = new BrowserProfileState
        {
            Running = false,
            UpdatedAtMs = UtcNowMs(),
            NextTabNumber = 1
        };
        _profiles[profile] = created;
        return created;
    }

    private static BrowserTabState ResolveNavigationTab(BrowserProfileState state, string? targetId)
    {
        if (!string.IsNullOrWhiteSpace(targetId))
        {
            var requested = state.Tabs.FirstOrDefault(x => x.TargetId.Equals(targetId, StringComparison.OrdinalIgnoreCase));
            if (requested is not null)
            {
                return requested;
            }
        }

        if (!string.IsNullOrWhiteSpace(state.ActiveTargetId))
        {
            var active = state.Tabs.FirstOrDefault(x => x.TargetId.Equals(state.ActiveTargetId, StringComparison.OrdinalIgnoreCase));
            if (active is not null)
            {
                return active;
            }
        }

        EnsureDefaultTab(state);
        return state.Tabs[^1];
    }

    private static BrowserTabState? ResolveClosableTab(BrowserProfileState state, string? targetId)
    {
        if (!string.IsNullOrWhiteSpace(targetId))
        {
            return state.Tabs.FirstOrDefault(x => x.TargetId.Equals(targetId, StringComparison.OrdinalIgnoreCase));
        }

        if (!string.IsNullOrWhiteSpace(state.ActiveTargetId))
        {
            var active = state.Tabs.FirstOrDefault(x => x.TargetId.Equals(state.ActiveTargetId, StringComparison.OrdinalIgnoreCase));
            if (active is not null)
            {
                return active;
            }
        }

        return state.Tabs.Count > 0 ? state.Tabs[^1] : null;
    }

    private static void EnsureDefaultTab(BrowserProfileState state)
    {
        if (state.Tabs.Count > 0)
        {
            if (string.IsNullOrWhiteSpace(state.ActiveTargetId))
            {
                state.ActiveTargetId = state.Tabs[^1].TargetId;
            }

            return;
        }

        var created = CreateTab(state, "about:blank");
        state.ActiveTargetId = created.TargetId;
    }

    private static BrowserTabState CreateTab(BrowserProfileState state, string url)
    {
        var now = UtcNowMs();
        var tab = new BrowserTabState
        {
            TargetId = $"tab-{state.NextTabNumber:D3}",
            Url = url,
            Title = BuildTitle(url),
            UpdatedAtMs = now
        };
        state.NextTabNumber++;
        state.Tabs.Add(tab);
        return tab;
    }

    private static string BuildTitle(string url)
    {
        if (string.Equals(url, "about:blank", StringComparison.OrdinalIgnoreCase))
        {
            return "Blank";
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return url;
        }

        var host = uri.Host.Trim();
        if (!string.IsNullOrWhiteSpace(host))
        {
            return host;
        }

        return uri.AbsoluteUri;
    }

    private static string? NormalizeUrl(string? url)
    {
        var candidate = (url ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(candidate))
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

        var scheme = parsed.Scheme;
        if (!scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
            && !scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return parsed.AbsoluteUri;
    }

    private static int ResolveLimit(int? limit)
    {
        if (!limit.HasValue || limit.Value <= 0)
        {
            return DefaultTabLimit;
        }

        return Math.Clamp(limit.Value, 1, MaxTabLimit);
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

    private sealed class BrowserProfileState
    {
        public bool Running { get; set; }
        public string? ActiveTargetId { get; set; }
        public long UpdatedAtMs { get; set; }
        public int NextTabNumber { get; set; }
        public List<BrowserTabState> Tabs { get; } = new();
    }

    private sealed class BrowserTabState
    {
        public string TargetId { get; set; } = string.Empty;
        public string Url { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public long UpdatedAtMs { get; set; }
    }
}
