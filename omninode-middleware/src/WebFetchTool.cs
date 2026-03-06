using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed record WebFetchToolResult(
    string Url,
    string? FinalUrl,
    int? Status,
    string ContentType,
    string ExtractMode,
    string Text,
    bool Truncated,
    int Length,
    bool Disabled,
    string? Error,
    ExternalContentDescriptor? ExternalContent = null
);

public sealed class WebFetchTool
{
    private const string DefaultSource = "web_fetch";
    private const string DefaultProvider = "native";
    private const int DefaultTimeoutSeconds = 10;
    private const int DefaultMaxChars = 50_000;
    private const int MaxAllowedChars = 120_000;
    private const int MaxRawChars = 300_000;
    private const int ErrorDetailMaxChars = 1_000;
    private static readonly HttpClient SharedHttpClient = CreateSharedHttpClient();
    private static readonly Regex HtmlTitleRegex = new(
        @"<title[^>]*>([\s\S]*?)</title>",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex HtmlTagRegex = new(
        @"<[^>]+>",
        RegexOptions.Compiled
    );
    private static readonly Regex MultiWhitespaceRegex = new(
        @"\s{2,}",
        RegexOptions.Compiled
    );

    private readonly HttpClient _httpClient;
    private readonly int _timeoutSeconds;

    public WebFetchTool(AppConfig config, HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? SharedHttpClient;
        _timeoutSeconds = NormalizeTimeoutSeconds(config.TavilyTimeoutSec);
    }

    public async Task<WebFetchToolResult> FetchAsync(
        string url,
        string? extractMode = null,
        int? maxChars = null,
        CancellationToken cancellationToken = default
    )
    {
        var requestedUrl = (url ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestedUrl))
        {
            return BuildInputError("url required");
        }

        if (!Uri.TryCreate(requestedUrl, UriKind.Absolute, out var parsedUri)
            || !IsHttpScheme(parsedUri))
        {
            return BuildInputError("invalid url (http/https only)");
        }

        var normalizedMode = NormalizeExtractMode(extractMode);
        var normalizedMaxChars = NormalizeMaxChars(maxChars);

        using var request = new HttpRequestMessage(HttpMethod.Get, parsedUri);
        request.Headers.TryAddWithoutValidation("Accept", "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1");
        request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");

        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            using var response = await _httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token)
                .ConfigureAwait(false);
            var statusCode = (int)response.StatusCode;
            var finalUrl = response.RequestMessage?.RequestUri?.AbsoluteUri ?? parsedUri.AbsoluteUri;
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            var raw = await response.Content.ReadAsStringAsync(timeoutCts.Token).ConfigureAwait(false);

            if (raw.Length > MaxRawChars)
            {
                raw = raw[..MaxRawChars];
            }

            if (!response.IsSuccessStatusCode)
            {
                var detail = BuildHttpErrorDetail(raw, contentType);
                return new WebFetchToolResult(
                    Url: parsedUri.AbsoluteUri,
                    FinalUrl: finalUrl,
                    Status: statusCode,
                    ContentType: contentType,
                    ExtractMode: normalizedMode,
                    Text: string.Empty,
                    Truncated: false,
                    Length: 0,
                    Disabled: true,
                    Error: $"web fetch http {statusCode}: {detail}"
                );
            }

            var prepared = PrepareContent(raw, contentType, normalizedMode);
            var trimmed = prepared.Trim();
            var truncated = false;
            if (trimmed.Length > normalizedMaxChars)
            {
                truncated = true;
                trimmed = trimmed[..normalizedMaxChars];
                if (trimmed.Length > 3)
                {
                    trimmed = trimmed[..^3] + "...";
                }
            }

            var wrappedText = ExternalContentGuard.WrapWebContent(trimmed, ExternalContentSource.WebFetch);
            var externalContent = new ExternalContentDescriptor(
                Untrusted: true,
                Source: DefaultSource,
                Provider: DefaultProvider,
                Wrapped: true
            );

            return new WebFetchToolResult(
                Url: parsedUri.AbsoluteUri,
                FinalUrl: finalUrl,
                Status: statusCode,
                ContentType: contentType,
                ExtractMode: normalizedMode,
                Text: wrappedText,
                Truncated: truncated,
                Length: wrappedText.Length,
                Disabled: false,
                Error: null,
                ExternalContent: externalContent
            );
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new WebFetchToolResult(
                Url: parsedUri.AbsoluteUri,
                FinalUrl: null,
                Status: null,
                ContentType: string.Empty,
                ExtractMode: normalizedMode,
                Text: string.Empty,
                Truncated: false,
                Length: 0,
                Disabled: true,
                Error: "web fetch request timeout"
            );
        }
        catch (Exception ex)
        {
            return new WebFetchToolResult(
                Url: parsedUri.AbsoluteUri,
                FinalUrl: null,
                Status: null,
                ContentType: string.Empty,
                ExtractMode: normalizedMode,
                Text: string.Empty,
                Truncated: false,
                Length: 0,
                Disabled: true,
                Error: ex.Message
            );
        }
    }

    private static WebFetchToolResult BuildInputError(string message)
    {
        return new WebFetchToolResult(
            Url: string.Empty,
            FinalUrl: null,
            Status: null,
            ContentType: string.Empty,
            ExtractMode: "markdown",
            Text: string.Empty,
            Truncated: false,
            Length: 0,
            Disabled: false,
            Error: message
        );
    }

    private static int NormalizeTimeoutSeconds(int configured)
    {
        if (configured <= 0)
        {
            return DefaultTimeoutSeconds;
        }

        return Math.Clamp(configured, 2, 120);
    }

    private static string NormalizeExtractMode(string? extractMode)
    {
        return string.Equals((extractMode ?? string.Empty).Trim(), "text", StringComparison.OrdinalIgnoreCase)
            ? "text"
            : "markdown";
    }

    private static int NormalizeMaxChars(int? maxChars)
    {
        if (!maxChars.HasValue || maxChars.Value <= 0)
        {
            return DefaultMaxChars;
        }

        return Math.Clamp(maxChars.Value, 100, MaxAllowedChars);
    }

    private static bool IsHttpScheme(Uri uri)
    {
        return uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase)
               || uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildHttpErrorDetail(string raw, string contentType)
    {
        var prepared = PrepareContent(raw, contentType, "text");
        var trimmed = prepared.Trim();
        if (trimmed.Length == 0)
        {
            return "empty error response";
        }

        if (trimmed.Length <= ErrorDetailMaxChars)
        {
            return trimmed;
        }

        return trimmed[..ErrorDetailMaxChars] + "...";
    }

    private static string PrepareContent(string raw, string contentType, string extractMode)
    {
        var normalized = (raw ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');

        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        var isHtml = contentType.Contains("html", StringComparison.OrdinalIgnoreCase)
                     || LooksLikeHtml(normalized);
        if (!isHtml)
        {
            return normalized;
        }

        var titleMatch = HtmlTitleRegex.Match(normalized);
        var title = titleMatch.Success
            ? WebUtility.HtmlDecode(titleMatch.Groups[1].Value).Trim()
            : string.Empty;
        var stripped = HtmlTagRegex.Replace(normalized, " ");
        stripped = WebUtility.HtmlDecode(stripped);
        stripped = MultiWhitespaceRegex.Replace(stripped, " ").Trim();

        if (extractMode == "markdown")
        {
            if (string.IsNullOrWhiteSpace(title))
            {
                return stripped;
            }

            return $"# {title}\n\n{stripped}";
        }

        if (string.IsNullOrWhiteSpace(title))
        {
            return stripped;
        }

        return $"제목: {title}\n{stripped}";
    }

    private static bool LooksLikeHtml(string value)
    {
        var trimmed = value.TrimStart();
        if (trimmed.Length == 0)
        {
            return false;
        }

        var head = trimmed.Length > 256 ? trimmed[..256] : trimmed;
        return head.StartsWith("<!doctype html", StringComparison.OrdinalIgnoreCase)
               || head.StartsWith("<html", StringComparison.OrdinalIgnoreCase);
    }

    private static HttpClient CreateSharedHttpClient()
    {
        var client = new HttpClient();
        client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "Omni-node/1.0");
        return client;
    }
}
