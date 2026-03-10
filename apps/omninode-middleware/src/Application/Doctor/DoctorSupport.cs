using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OmniNode.Middleware;

internal sealed record DoctorProcessResult(
    int ExitCode,
    string StdOut,
    string StdErr
);

internal static class DoctorSupport
{
    public static async Task<DoctorProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken
    )
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        process.Start();

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        return new DoctorProcessResult(
            process.ExitCode,
            await stdoutTask,
            await stderrTask
        );
    }

    public static string ResolveCoreLockPath()
    {
        if (OperatingSystem.IsWindows())
        {
            return Path.Combine(Path.GetTempPath(), "omninode.lock");
        }

        try
        {
            return $"/tmp/omninode.{GetCurrentUnixUid()}.lock";
        }
        catch
        {
            return "/tmp/omninode.lock";
        }
    }

    public static string Trim(string? text, int maxLength = 280)
    {
        var normalized = (text ?? string.Empty).Trim();
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..Math.Max(0, maxLength - 3)] + "...";
    }

    public static bool TryGetUnixFileMode(string path, out UnixFileMode mode)
    {
        mode = default;
        if (OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            mode = File.GetUnixFileMode(path);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static bool HasLoosePermissions(UnixFileMode mode)
    {
        const UnixFileMode forbidden =
            UnixFileMode.GroupRead
            | UnixFileMode.GroupWrite
            | UnixFileMode.GroupExecute
            | UnixFileMode.OtherRead
            | UnixFileMode.OtherWrite
            | UnixFileMode.OtherExecute;

        return (mode & forbidden) != 0;
    }

    public static string FormatUnixFileMode(UnixFileMode mode)
    {
        return Convert.ToString((int)mode, 8).PadLeft(4, '0');
    }

    private static uint GetCurrentUnixUid()
    {
        if (OperatingSystem.IsWindows())
        {
            return 0;
        }

        return PosixNative.getuid();
    }

    private static class PosixNative
    {
        [DllImport("libc", SetLastError = true)]
        internal static extern uint getuid();
    }
}
