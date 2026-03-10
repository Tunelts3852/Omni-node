using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace OmniNode.Middleware;

internal sealed record LspPosition(int Line, int Character);

internal sealed class LspStdioClient : IAsyncDisposable
{
    private readonly Process _process;
    private readonly Stream _stdout;
    private readonly Stream _stdin;
    private readonly StringBuilder _stderrBuffer = new();
    private readonly object _stderrLock = new();
    private int _nextId;

    private LspStdioClient(Process process)
    {
        _process = process;
        _stdout = process.StandardOutput.BaseStream;
        _stdin = process.StandardInput.BaseStream;
        _process.ErrorDataReceived += (_, args) =>
        {
            if (string.IsNullOrWhiteSpace(args.Data))
            {
                return;
            }

            lock (_stderrLock)
            {
                if (_stderrBuffer.Length > 0)
                {
                    _stderrBuffer.AppendLine();
                }

                _stderrBuffer.Append(args.Data);
            }
        };
        _process.BeginErrorReadLine();
    }

    public string OffsetEncoding { get; private set; } = "utf-16";

    public static LspStdioClient Start(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory
    )
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        var process = new Process { StartInfo = startInfo };
        process.Start();
        return new LspStdioClient(process);
    }

    public async Task InitializeAsync(string workspaceRoot, CancellationToken cancellationToken)
    {
        using var result = await SendRequestAsync(
            "initialize",
            writer =>
            {
                writer.WriteStartObject();
                writer.WriteNumber("processId", Environment.ProcessId);
                writer.WriteString("rootUri", ToUri(workspaceRoot));
                writer.WritePropertyName("capabilities");
                writer.WriteStartObject();
                writer.WritePropertyName("workspace");
                writer.WriteStartObject();
                writer.WritePropertyName("workspaceEdit");
                writer.WriteStartObject();
                writer.WriteBoolean("documentChanges", true);
                writer.WriteEndObject();
                writer.WriteEndObject();
                writer.WritePropertyName("textDocument");
                writer.WriteStartObject();
                writer.WritePropertyName("documentSymbol");
                writer.WriteStartObject();
                writer.WriteBoolean("hierarchicalDocumentSymbolSupport", true);
                writer.WriteEndObject();
                writer.WriteEndObject();
                writer.WritePropertyName("general");
                writer.WriteStartObject();
                writer.WritePropertyName("positionEncodings");
                writer.WriteStartArray();
                writer.WriteStringValue("utf-8");
                writer.WriteStringValue("utf-16");
                writer.WriteEndArray();
                writer.WriteEndObject();
                writer.WritePropertyName("offsetEncoding");
                writer.WriteStartArray();
                writer.WriteStringValue("utf-8");
                writer.WriteStringValue("utf-16");
                writer.WriteEndArray();
                writer.WriteEndObject();
                writer.WritePropertyName("workspaceFolders");
                writer.WriteStartArray();
                writer.WriteStartObject();
                writer.WriteString("uri", ToUri(workspaceRoot));
                writer.WriteString(
                    "name",
                    Path.GetFileName(workspaceRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                );
                writer.WriteEndObject();
                writer.WriteEndArray();
                writer.WriteEndObject();
            },
            cancellationToken
        );

        if (result.RootElement.TryGetProperty("capabilities", out var capabilities))
        {
            if (capabilities.TryGetProperty("positionEncoding", out var positionEncoding)
                && positionEncoding.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(positionEncoding.GetString()))
            {
                OffsetEncoding = NormalizeOffsetEncoding(positionEncoding.GetString());
            }
            else if (capabilities.TryGetProperty("offsetEncoding", out var offsetEncoding))
            {
                OffsetEncoding = offsetEncoding.ValueKind switch
                {
                    JsonValueKind.Array => NormalizeOffsetEncoding(FindFirstString(offsetEncoding)),
                    JsonValueKind.String => NormalizeOffsetEncoding(offsetEncoding.GetString()),
                    _ => OffsetEncoding
                };
            }
        }

        await SendNotificationAsync(
            "initialized",
            writer =>
            {
                writer.WriteStartObject();
                writer.WriteEndObject();
            },
            cancellationToken
        );
    }

    public Task OpenDocumentAsync(
        string path,
        string languageId,
        string text,
        CancellationToken cancellationToken
    )
    {
        return SendNotificationAsync(
            "textDocument/didOpen",
            writer =>
            {
                writer.WriteStartObject();
                writer.WritePropertyName("textDocument");
                writer.WriteStartObject();
                writer.WriteString("uri", ToUri(path));
                writer.WriteString("languageId", languageId);
                writer.WriteNumber("version", 1);
                writer.WriteString("text", text);
                writer.WriteEndObject();
                writer.WriteEndObject();
            },
            cancellationToken
        );
    }

    public Task<JsonDocument> RequestDocumentSymbolsAsync(string path, CancellationToken cancellationToken)
    {
        return SendRequestAsync(
            "textDocument/documentSymbol",
            writer =>
            {
                writer.WriteStartObject();
                writer.WritePropertyName("textDocument");
                writer.WriteStartObject();
                writer.WriteString("uri", ToUri(path));
                writer.WriteEndObject();
                writer.WriteEndObject();
            },
            cancellationToken
        );
    }

    public Task<JsonDocument> RequestRenameAsync(
        string path,
        LspPosition position,
        string newName,
        CancellationToken cancellationToken
    )
    {
        return SendRequestAsync(
            "textDocument/rename",
            writer =>
            {
                writer.WriteStartObject();
                writer.WritePropertyName("textDocument");
                writer.WriteStartObject();
                writer.WriteString("uri", ToUri(path));
                writer.WriteEndObject();
                writer.WritePropertyName("position");
                writer.WriteStartObject();
                writer.WriteNumber("line", position.Line);
                writer.WriteNumber("character", position.Character);
                writer.WriteEndObject();
                writer.WriteString("newName", newName);
                writer.WriteEndObject();
            },
            cancellationToken
        );
    }

    public string GetDiagnostics()
    {
        lock (_stderrLock)
        {
            return DoctorSupport.Trim(_stderrBuffer.ToString(), 1_200);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                try
                {
                    using var _ = await SendRequestAsync("shutdown", null, CancellationToken.None);
                }
                catch
                {
                }

                try
                {
                    await SendNotificationAsync("exit", null, CancellationToken.None);
                }
                catch
                {
                }
            }
        }
        finally
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
            }

            _process.Dispose();
        }
    }

    private async Task<JsonDocument> SendRequestAsync(
        string method,
        Action<Utf8JsonWriter>? writeParams,
        CancellationToken cancellationToken
    )
    {
        var id = Interlocked.Increment(ref _nextId);
        await WriteMessageAsync(method, id, writeParams, cancellationToken);

        while (true)
        {
            using var response = await ReadMessageAsync(cancellationToken);
            var root = response.RootElement;
            if (!root.TryGetProperty("id", out var responseId))
            {
                continue;
            }

            if (responseId.ValueKind != JsonValueKind.Number || responseId.GetInt32() != id)
            {
                continue;
            }

            if (root.TryGetProperty("error", out var error))
            {
                var message = error.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : "LSP 요청이 실패했습니다.";
                throw new InvalidOperationException(message);
            }

            if (!root.TryGetProperty("result", out var result))
            {
                return JsonDocument.Parse("null");
            }

            return JsonDocument.Parse(result.GetRawText());
        }
    }

    private Task SendNotificationAsync(
        string method,
        Action<Utf8JsonWriter>? writeParams,
        CancellationToken cancellationToken
    )
    {
        return WriteMessageAsync(method, null, writeParams, cancellationToken);
    }

    private async Task WriteMessageAsync(
        string method,
        int? id,
        Action<Utf8JsonWriter>? writeParams,
        CancellationToken cancellationToken
    )
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            if (id.HasValue)
            {
                writer.WriteNumber("id", id.Value);
            }

            writer.WriteString("method", method);
            if (writeParams != null)
            {
                writer.WritePropertyName("params");
                writeParams(writer);
            }

            writer.WriteEndObject();
            writer.Flush();
        }

        var content = stream.ToArray();
        var header = Encoding.ASCII.GetBytes($"Content-Length: {content.Length}\r\n\r\n");
        await _stdin.WriteAsync(header, cancellationToken);
        await _stdin.WriteAsync(content, cancellationToken);
        await _stdin.FlushAsync(cancellationToken);
    }

    private async Task<JsonDocument> ReadMessageAsync(CancellationToken cancellationToken)
    {
        var headerBuffer = new List<byte>(256);
        while (true)
        {
            var nextByte = new byte[1];
            var read = await _stdout.ReadAsync(nextByte, cancellationToken);
            if (read == 0)
            {
                throw new InvalidOperationException("LSP 서버가 응답 없이 종료되었습니다.");
            }

            headerBuffer.Add(nextByte[0]);
            var count = headerBuffer.Count;
            if (count >= 4
                && headerBuffer[count - 4] == '\r'
                && headerBuffer[count - 3] == '\n'
                && headerBuffer[count - 2] == '\r'
                && headerBuffer[count - 1] == '\n')
            {
                break;
            }
        }

        var headerText = Encoding.ASCII.GetString(headerBuffer.ToArray());
        var contentLength = ParseContentLength(headerText);
        var content = new byte[contentLength];
        await ReadExactlyAsync(_stdout, content, cancellationToken);
        return JsonDocument.Parse(content);
    }

    private static int ParseContentLength(string headerText)
    {
        foreach (var line in headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var raw = line["Content-Length:".Length..].Trim();
            if (int.TryParse(raw, out var value) && value >= 0)
            {
                return value;
            }
        }

        throw new InvalidOperationException("LSP Content-Length 헤더를 읽지 못했습니다.");
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, buffer.Length - offset), cancellationToken);
            if (read == 0)
            {
                throw new InvalidOperationException("LSP 본문을 끝까지 읽지 못했습니다.");
            }

            offset += read;
        }
    }

    private static string ToUri(string path)
    {
        return new Uri(Path.GetFullPath(path)).AbsoluteUri;
    }

    private static string NormalizeOffsetEncoding(string? value)
    {
        return string.Equals(value, "utf-8", StringComparison.OrdinalIgnoreCase)
            ? "utf-8"
            : "utf-16";
    }

    private static string? FindFirstString(JsonElement element)
    {
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                return item.GetString();
            }
        }

        return null;
    }
}
