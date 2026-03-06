using System.Net.Sockets;
using System.Text;

namespace OmniNode.Middleware;

public sealed class UdsCoreClient
{
    private readonly string _socketPath;

    public UdsCoreClient(string socketPath)
    {
        _socketPath = socketPath;
    }

    public Task<string> GetMetricsAsync(CancellationToken cancellationToken)
    {
        return RequestAsync("{\"action\":\"get_metrics\"}", cancellationToken);
    }

    public Task<string> KillAsync(int pid, CancellationToken cancellationToken)
    {
        return RequestAsync($"{{\"action\":\"kill\",\"pid\":{pid}}}", cancellationToken);
    }

    public async Task<string> RequestAsync(string jsonRequest, CancellationToken cancellationToken)
    {
        using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        var endpoint = new UnixDomainSocketEndPoint(_socketPath);

        await socket.ConnectAsync(endpoint, cancellationToken);

        var requestBytes = Encoding.UTF8.GetBytes(jsonRequest + "\n");
        await socket.SendAsync(requestBytes, SocketFlags.None, cancellationToken);

        var buffer = new byte[8192];
        var builder = new StringBuilder();

        while (true)
        {
            var read = await socket.ReceiveAsync(buffer, SocketFlags.None, cancellationToken);
            if (read <= 0)
            {
                break;
            }

            builder.Append(Encoding.UTF8.GetString(buffer, 0, read));
            if (builder.ToString().Contains('\n'))
            {
                break;
            }
        }

        return builder.ToString().Trim();
    }
}

