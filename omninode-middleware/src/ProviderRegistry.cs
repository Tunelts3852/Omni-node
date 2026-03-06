namespace OmniNode.Middleware;

public sealed record ProviderAvailability(string Provider, bool Available, string Reason);

public sealed class ProviderRegistry
{
    private static readonly string[] AutoPriority = { "gemini", "groq", "cerebras", "copilot" };
    private readonly LlmRouter _llmRouter;
    private readonly CopilotCliWrapper _copilotWrapper;

    public ProviderRegistry(LlmRouter llmRouter, CopilotCliWrapper copilotWrapper)
    {
        _llmRouter = llmRouter;
        _copilotWrapper = copilotWrapper;
    }

    public async Task<IReadOnlyList<string>> GetAvailableProvidersAsync(CancellationToken cancellationToken)
    {
        var snapshot = await GetAvailabilitySnapshotAsync(cancellationToken);
        return snapshot
            .Where(item => item.Available)
            .Select(item => item.Provider)
            .ToArray();
    }

    public async Task<string> ResolveAutoProviderAsync(CancellationToken cancellationToken)
    {
        var available = await GetAvailableProvidersAsync(cancellationToken);
        foreach (var provider in AutoPriority)
        {
            if (available.Contains(provider, StringComparer.OrdinalIgnoreCase))
            {
                return provider;
            }
        }

        return "none";
    }

    public async Task<IReadOnlyList<ProviderAvailability>> GetAvailabilitySnapshotAsync(CancellationToken cancellationToken)
    {
        var items = new List<ProviderAvailability>(4)
        {
            _llmRouter.HasGeminiApiKey()
                ? new ProviderAvailability("gemini", true, "configured")
                : new ProviderAvailability("gemini", false, "api_key_missing"),
            _llmRouter.HasGroqApiKey()
                ? new ProviderAvailability("groq", true, "configured")
                : new ProviderAvailability("groq", false, "api_key_missing"),
            _llmRouter.HasCerebrasApiKey()
                ? new ProviderAvailability("cerebras", true, "configured")
                : new ProviderAvailability("cerebras", false, "api_key_missing")
        };

        var copilot = await _copilotWrapper.GetStatusAsync(cancellationToken);
        items.Add(copilot.Installed && copilot.Authenticated
            ? new ProviderAvailability("copilot", true, "ready")
            : new ProviderAvailability("copilot", false, "not_ready"));

        return items;
    }
}
