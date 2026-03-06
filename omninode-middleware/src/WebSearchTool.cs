using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace OmniNode.Middleware;

public sealed record WebSearchResultItem(
    string Title,
    string Url,
    string Description,
    string? Published,
    string CitationId = "-"
);

public sealed record ExternalContentDescriptor(
    bool Untrusted,
    string Source,
    string Provider,
    bool Wrapped
);

public sealed record WebSearchToolResult(
    string Provider,
    IReadOnlyList<WebSearchResultItem> Results,
    bool Disabled,
    string? Error,
    ExternalContentDescriptor? ExternalContent = null,
    SearchAnswerGuardFailure? GuardFailure = null,
    int RetryAttempt = 0,
    int RetryMaxAttempts = 0,
    string RetryStopReason = "-"
);

public sealed class WebSearchTool
{
    private const string TavilyProvider = "tavily";
    private const string WebSearchSource = "web_search";
    private const string DefaultEndpoint = "https://api.tavily.com/search";
    private const int DefaultTimeoutSeconds = 15;
    private const int DefaultMaxResults = 5;
    private const int MaxAllowedResults = 10;
    private static readonly HttpClient SharedHttpClient = CreateSharedHttpClient();

    private readonly RuntimeSettings _runtimeSettings;
    private readonly Uri _endpoint;
    private readonly int _timeoutSeconds;
    private readonly int _defaultMaxResults;
    private readonly HttpClient _httpClient;

    public WebSearchTool(AppConfig config, RuntimeSettings runtimeSettings, HttpClient? httpClient = null)
    {
        _runtimeSettings = runtimeSettings;
        _endpoint = ResolveEndpoint(config.TavilyBaseUrl);
        _timeoutSeconds = NormalizeTimeout(config.TavilyTimeoutSec);
        _defaultMaxResults = NormalizeConfiguredMaxResults(config.TavilyMaxResults);
        _httpClient = httpClient ?? SharedHttpClient;
    }

    public async Task<WebSearchToolResult> SearchAsync(
        string query,
        int? count = null,
        string? freshness = null,
        CancellationToken cancellationToken = default
    )
    {
        var cleanedQuery = (query ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(cleanedQuery))
        {
            return new WebSearchToolResult(TavilyProvider, Array.Empty<WebSearchResultItem>(), false, "query required");
        }

        var apiKey = (_runtimeSettings.GetTavilyApiKey() ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return new WebSearchToolResult(TavilyProvider, Array.Empty<WebSearchResultItem>(), true, "tavily api key missing");
        }

        var freshnessRaw = (freshness ?? string.Empty).Trim();
        var normalizedFreshness = NormalizeFreshness(freshnessRaw);
        if (freshnessRaw.Length > 0 && normalizedFreshness == null)
        {
            return new WebSearchToolResult(
                TavilyProvider,
                Array.Empty<WebSearchResultItem>(),
                false,
                "invalid freshness (use day/week/month/year)"
            );
        }

        var normalizedCount = NormalizeCount(count, _defaultMaxResults);
        var requestJson = BuildRequestJson(cleanedQuery, normalizedCount, apiKey, normalizedFreshness);

        using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Content = new StringContent(requestJson, Encoding.UTF8, "application/json");

        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            using var response = await _httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token)
                .ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(timeoutCts.Token).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var detail = ExtractErrorDetail(body);
                return new WebSearchToolResult(
                    TavilyProvider,
                    Array.Empty<WebSearchResultItem>(),
                    true,
                    $"tavily http {(int)response.StatusCode}: {detail}"
                );
            }

            var mapped = MapResults(body, normalizedCount);
            var externalContent = new ExternalContentDescriptor(
                Untrusted: true,
                Source: WebSearchSource,
                Provider: TavilyProvider,
                Wrapped: true
            );
            return new WebSearchToolResult(TavilyProvider, mapped, false, null, externalContent);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new WebSearchToolResult(TavilyProvider, Array.Empty<WebSearchResultItem>(), true, "tavily request timeout");
        }
        catch (Exception ex)
        {
            return new WebSearchToolResult(TavilyProvider, Array.Empty<WebSearchResultItem>(), true, ex.Message);
        }
    }

    private static Uri ResolveEndpoint(string? configured)
    {
        var raw = string.IsNullOrWhiteSpace(configured) ? DefaultEndpoint : configured.Trim();
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri))
        {
            return new Uri(DefaultEndpoint, UriKind.Absolute);
        }

        if (!uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
            && !uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            return new Uri(DefaultEndpoint, UriKind.Absolute);
        }

        var path = uri.AbsolutePath;
        if (string.IsNullOrWhiteSpace(path) || path == "/")
        {
            return new Uri(uri, "/search");
        }

        return uri;
    }

    private static int NormalizeTimeout(int timeoutSeconds)
    {
        if (timeoutSeconds <= 0)
        {
            return DefaultTimeoutSeconds;
        }

        return Math.Clamp(timeoutSeconds, 1, 120);
    }

    private static int NormalizeConfiguredMaxResults(int configuredMaxResults)
    {
        if (configuredMaxResults <= 0)
        {
            return DefaultMaxResults;
        }

        return Math.Clamp(configuredMaxResults, 1, MaxAllowedResults);
    }

    private static int NormalizeCount(int? count, int fallback)
    {
        if (!count.HasValue || count.Value <= 0)
        {
            return fallback;
        }

        return Math.Clamp(count.Value, 1, MaxAllowedResults);
    }

    private static string? NormalizeFreshness(string freshness)
    {
        var normalized = freshness.Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized switch
        {
            "d" or "day" or "pd" => "day",
            "w" or "week" or "pw" => "week",
            "m" or "month" or "pm" => "month",
            "y" or "year" or "py" => "year",
            _ => null
        };
    }

    private static string BuildRequestJson(string query, int maxResults, string apiKey, string? freshness)
    {
        var builder = new StringBuilder();
        builder.Append("{");
        builder.Append($"\"query\":\"{EscapeJson(query)}\",");
        builder.Append($"\"max_results\":{maxResults},");
        builder.Append("\"include_answer\":false,");
        builder.Append("\"include_raw_content\":false,");
        builder.Append($"\"api_key\":\"{EscapeJson(apiKey)}\"");
        if (!string.IsNullOrWhiteSpace(freshness))
        {
            builder.Append($",\"time_range\":\"{EscapeJson(freshness)}\"");
        }

        builder.Append("}");
        return builder.ToString();
    }

    private static IReadOnlyList<WebSearchResultItem> MapResults(string body, int maxResults)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return Array.Empty<WebSearchResultItem>();
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            if (!document.RootElement.TryGetProperty("results", out var resultsElement)
                || resultsElement.ValueKind != JsonValueKind.Array)
            {
                return Array.Empty<WebSearchResultItem>();
            }

            var mapped = new List<WebSearchResultItem>();
            foreach (var item in resultsElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var url = ReadString(item, "url");
                if (!IsHttpUrl(url))
                {
                    continue;
                }

                var title = ReadString(item, "title");
                var description = ReadFirstString(item, "content", "description");
                var publishedRaw = ReadFirstString(item, "published_date", "published", "publishedDate");
                var published = NormalizePublished(publishedRaw);
                var wrappedTitle = WrapWebSearchText(title);
                var wrappedDescription = WrapWebSearchText(description);

                mapped.Add(new WebSearchResultItem(wrappedTitle, url, wrappedDescription, published));
                if (mapped.Count >= maxResults)
                {
                    break;
                }
            }

            return mapped;
        }
        catch
        {
            return Array.Empty<WebSearchResultItem>();
        }
    }

    private static string WrapWebSearchText(string value)
    {
        var text = (value ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return string.Empty;
        }

        return ExternalContentGuard.WrapWebContent(text, ExternalContentSource.WebSearch);
    }

    private static string ReadString(JsonElement obj, string propertyName)
    {
        if (!obj.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return string.Empty;
        }

        return (value.GetString() ?? string.Empty).Trim();
    }

    private static string ReadFirstString(JsonElement obj, params string[] propertyNames)
    {
        foreach (var propertyName in propertyNames)
        {
            var value = ReadString(obj, propertyName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return string.Empty;
    }

    private static bool IsHttpUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
               || uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase);
    }

    private static string? NormalizePublished(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeUniversal,
                out var parsed))
        {
            return parsed.ToUniversalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        return value.Length <= 64 ? value : value[..64];
    }

    private static string ExtractErrorDetail(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return "request failed";
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                var detail = ReadFirstString(root, "error", "message", "detail");
                if (!string.IsNullOrWhiteSpace(detail))
                {
                    return detail.Length <= 280 ? detail : detail[..280];
                }
            }
        }
        catch
        {
        }

        var compact = body.Trim();
        return compact.Length <= 280 ? compact : compact[..280];
    }

    private static string EscapeJson(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
    }

    private static HttpClient CreateSharedHttpClient()
    {
        return new HttpClient
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
    }
}
