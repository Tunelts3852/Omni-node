using System.Globalization;
using System.Net;
using System.Text;

namespace OmniNode.Middleware;

internal sealed class GatewayApiEndpoint
{
    private const string GuardRetryTimelineApiPath = "/api/guard/retry-timeline";
    private const string LocalImageApiPath = "/api/local-image";
    private readonly GuardRetryTimelineStore _guardRetryTimelineStore;

    public GatewayApiEndpoint(GuardRetryTimelineStore guardRetryTimelineStore)
    {
        _guardRetryTimelineStore = guardRetryTimelineStore;
    }

    public async Task<bool> TryHandleAsync(
        HttpListenerContext context,
        string path,
        CancellationToken cancellationToken
    )
    {
        if (path.Equals(GuardRetryTimelineApiPath, StringComparison.OrdinalIgnoreCase))
        {
            await HandleGuardRetryTimelineApiAsync(context, cancellationToken);
            return true;
        }

        if (path.Equals(LocalImageApiPath, StringComparison.OrdinalIgnoreCase))
        {
            await HandleLocalImageApiAsync(context, cancellationToken);
            return true;
        }

        return false;
    }

    private async Task HandleGuardRetryTimelineApiAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var method = context.Request.HttpMethod?.ToUpperInvariant() ?? "GET";
        if (method != "GET" && method != "HEAD")
        {
            context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
            context.Response.Headers["Allow"] = "GET, HEAD";
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "Method Not Allowed", cancellationToken);
            return;
        }

        var bucketMinutes = ParseQueryInt(
            context.Request.QueryString["bucketMinutes"],
            1,
            60
        );
        var windowMinutes = ParseQueryInt(
            context.Request.QueryString["windowMinutes"],
            1,
            24 * 60
        );
        var maxBucketRows = ParseQueryInt(
            context.Request.QueryString["maxBucketRows"],
            1,
            288
        );
        var channels = ParseChannelsQuery(context.Request.QueryString["channels"]);
        var payload = _guardRetryTimelineStore.BuildSnapshotJson(
            bucketMinutes: bucketMinutes,
            windowMinutes: windowMinutes,
            maxBucketRows: maxBucketRows,
            channels: channels
        );

        context.Response.StatusCode = (int)HttpStatusCode.OK;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        if (method == "HEAD")
        {
            context.Response.ContentLength64 = 0;
            context.Response.OutputStream.Close();
            return;
        }

        await WriteResponseAsync(
            context.Response,
            "application/json; charset=utf-8",
            payload,
            cancellationToken
        );
    }

    private async Task HandleLocalImageApiAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var method = context.Request.HttpMethod?.ToUpperInvariant() ?? "GET";
        if (method != "GET" && method != "HEAD")
        {
            context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
            context.Response.Headers["Allow"] = "GET, HEAD";
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "Method Not Allowed", cancellationToken);
            return;
        }

        var requestedPath = (context.Request.QueryString["path"] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestedPath) || !Path.IsPathRooted(requestedPath))
        {
            context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "absolute image path is required", cancellationToken);
            return;
        }

        var fullPath = Path.GetFullPath(requestedPath);
        var extension = Path.GetExtension(fullPath);
        var contentType = extension.ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            _ => string.Empty
        };

        if (string.IsNullOrWhiteSpace(contentType))
        {
            context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "unsupported image type", cancellationToken);
            return;
        }

        if (!File.Exists(fullPath))
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            await WriteResponseAsync(context.Response, "text/plain; charset=utf-8", "image not found", cancellationToken);
            return;
        }

        context.Response.StatusCode = (int)HttpStatusCode.OK;
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        if (method == "HEAD")
        {
            context.Response.ContentType = contentType;
            context.Response.ContentLength64 = 0;
            context.Response.OutputStream.Close();
            return;
        }

        var bytes = await File.ReadAllBytesAsync(fullPath, cancellationToken);
        await WriteBinaryResponseAsync(context.Response, contentType, bytes, cancellationToken);
    }

    private static int? ParseQueryInt(string? raw, int min, int max)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return null;
        }

        return Math.Clamp(parsed, min, max);
    }

    private static string[]? ParseChannelsQuery(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var channels = raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return channels.Length > 0 ? channels : null;
    }

    private static async Task WriteResponseAsync(
        HttpListenerResponse response,
        string contentType,
        string body,
        CancellationToken cancellationToken
    )
    {
        response.ContentType = contentType;
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["X-Frame-Options"] = "DENY";
        var bytes = Encoding.UTF8.GetBytes(body);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes, cancellationToken);
        response.OutputStream.Close();
    }

    private static async Task WriteBinaryResponseAsync(
        HttpListenerResponse response,
        string contentType,
        byte[] body,
        CancellationToken cancellationToken
    )
    {
        response.ContentType = contentType;
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["X-Frame-Options"] = "DENY";
        response.ContentLength64 = body.Length;
        await response.OutputStream.WriteAsync(body, cancellationToken);
        response.OutputStream.Close();
    }
}
