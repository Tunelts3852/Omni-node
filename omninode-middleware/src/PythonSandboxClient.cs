using System.Diagnostics;

namespace OmniNode.Middleware;

public sealed class PythonSandboxClient
{
    private readonly string _pythonBinary;
    private readonly string _executorPath;

    public PythonSandboxClient(string pythonBinary, string executorPath)
    {
        _pythonBinary = pythonBinary;
        _executorPath = Path.GetFullPath(executorPath);
    }

    public async Task<string> ExecuteCodeAsync(string code, CancellationToken cancellationToken)
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"omninode_{Guid.NewGuid():N}.py");
        await File.WriteAllTextAsync(tempPath, code, cancellationToken);

        try
        {
            return await ExecuteScriptAsync(tempPath, cancellationToken);
        }
        finally
        {
            try
            {
                File.Delete(tempPath);
            }
            catch
            {
            }
        }
    }

    public async Task<string> ExecuteScriptAsync(string scriptPath, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _pythonBinary,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        startInfo.ArgumentList.Add(_executorPath);
        startInfo.ArgumentList.Add("--script");
        startInfo.ArgumentList.Add(scriptPath);

        using var process = new Process { StartInfo = startInfo };
        process.Start();

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (process.ExitCode != 0)
        {
            return string.IsNullOrWhiteSpace(stdout) ? stderr : stdout;
        }

        return stdout;
    }
}

