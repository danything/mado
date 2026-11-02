using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace Mado;

/// <summary>
/// Windows の擬似端末(ConPTY)で 1 つのプロセスを動かす。Native AOT で動くよう、P/Invoke は LibraryImport(ソース生成)で書く。
///
/// - CreatePseudoConsole に入出力のパイプを渡し、PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE を付けて CreateProcess する
/// - 子はジョブ(閉じたら中を全部止める)に入れてから動かす。mado が落ちても talosctl を残さない
/// - 出力は 1 本のタスクがいつも読み続ける。ConPTY は出力を読まれないと ClosePseudoConsole で止まることがあるため
/// - プロセスが終わったら ClosePseudoConsole して、出力の終わり(0)を返す
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed partial class ConPty : ITerminal
{
    readonly nint _hpc;
    readonly SafeFileHandle _process;
    readonly SafeFileHandle _job;
    readonly FileStream _input;
    readonly FileStream _output;
    readonly IDisposable? _attached;
    readonly Channel<byte[]> _out = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
    readonly Task _reader;
    readonly Task _exited;
    byte[]? _rest;
    int _closed;
    int _disposed;

    public int ProcessId { get; }
    public int? ExitCode { get; private set; }

    ConPty(nint hpc, SafeFileHandle process, SafeFileHandle job, int pid, SafeFileHandle input, SafeFileHandle output, IDisposable? attached)
    {
        _hpc = hpc;
        _process = process;
        _job = job;
        ProcessId = pid;
        _attached = attached;
        _input = new FileStream(input, FileAccess.Write, 0, isAsync: false);
        _output = new FileStream(output, FileAccess.Read, 0, isAsync: false);
        _reader = Task.Run(ReadLoop);
        _exited = Task.Run(WaitExit);
    }

    /// <summary>commandLine は CreateProcess に渡す 1 行(TalosCommand.CommandLine)。attached は閉じるときに一緒に閉じる</summary>
    public static ConPty Start(string commandLine, int cols, int rows, IDisposable? attached = null)
    {
        // ConPTY が読む口(inRead)と書く口(outWrite)は ConPTY が複製して持つので、作ったら閉じる
        if (!CreatePipe(out var inRead, out var inWrite, 0, 0)) throw new Win32Exception();
        if (!CreatePipe(out var outRead, out var outWrite, 0, 0))
        {
            var e = new Win32Exception();
            inRead.Dispose();
            inWrite.Dispose();
            throw e;
        }
        nint hpc = 0;
        var job = new SafeFileHandle();
        var list = nint.Zero;
        try
        {
            var hr = CreatePseudoConsole(new Coord((short)cols, (short)rows), inRead, outWrite, 0, out hpc);
            if (hr != 0) throw new Win32Exception(hr);
            inRead.Dispose();
            outWrite.Dispose();

            job = CreateJobObjectW(0, null);
            if (job.IsInvalid) throw new Win32Exception();
            var limits = new JobExtendedLimitInformation { BasicLimitInformation = new JobBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose } };
            unsafe
            {
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, &limits, sizeof(JobExtendedLimitInformation)))
                    throw new Win32Exception();
            }

            nint size = 0;
            InitializeProcThreadAttributeList(0, 1, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
            if (!UpdateProcThreadAttribute(list, 0, ProcThreadAttributePseudoConsole, hpc, nint.Size, 0, 0)) throw new Win32Exception();

            ProcessInformation pi;
            unsafe
            {
                var si = new StartupInfoEx();
                si.StartupInfo.cb = sizeof(StartupInfoEx);
                // 標準の入出力の口は渡さない(空)。mado 自身の口(サービスなら無い)を子が受け継いで、端末を通らなくなるのを防ぐ
                si.StartupInfo.dwFlags = StartfUseStdHandles;
                si.lpAttributeList = list;
                var cmd = (commandLine + '\0').ToCharArray();
                fixed (char* c = cmd)
                {
                    if (!CreateProcessW(null, c, 0, 0, false, ExtendedStartupInfoPresent | CreateSuspended, 0, null, &si, &pi))
                        throw new Win32Exception();
                }
            }
            var process = new SafeFileHandle(pi.hProcess, ownsHandle: true);
            using (var thread = new SafeFileHandle(pi.hThread, ownsHandle: true))
            {
                // ジョブに入れてから動かす(入れる前に子が動き出すと、ジョブの外に孫を作れてしまう)
                if (!AssignProcessToJobObject(job, process) || ResumeThread(thread) == uint.MaxValue)
                {
                    var e = new Win32Exception();
                    TerminateProcess(process, 1);
                    process.Dispose();
                    throw e;
                }
            }
            var pty = new ConPty(hpc, process, job, pi.dwProcessId, inWrite, outRead, attached);
            hpc = 0;
            return pty;
        }
        catch
        {
            if (hpc != 0) ClosePseudoConsole(hpc);
            job.Dispose();
            inRead.Dispose();
            outWrite.Dispose();
            inWrite.Dispose();
            outRead.Dispose();
            throw;
        }
        finally
        {
            if (list != 0)
            {
                DeleteProcThreadAttributeList(list);
                Marshal.FreeHGlobal(list);
            }
        }
    }

    async Task ReadLoop()
    {
        var b = new byte[16 * 1024];
        try
        {
            int n;
            while ((n = await _output.ReadAsync(b)) > 0) _out.Writer.TryWrite(b[..n]);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or OperationCanceledException) { }
        finally
        {
            _out.Writer.TryComplete();
        }
    }

    /// <summary>プロセスが終わるのを待ち、終了コードを取って ConPTY を閉じる(出力の終わりが届く)</summary>
    async Task WaitExit()
    {
        using var wait = new ProcessWaitHandle(_process);
        var done = new TaskCompletionSource();
        var reg = ThreadPool.RegisterWaitForSingleObject(wait, (_, _) => done.TrySetResult(), null, Timeout.Infinite, executeOnlyOnce: true);
        try { await done.Task; }
        finally { reg.Unregister(null); }
        if (GetExitCodeProcess(_process, out var code)) ExitCode = (int)code;
        ClosePty();
    }

    void ClosePty()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0) return;
        // 出力は ReadLoop が読み続けているので、ここで止まり続けることはない
        ClosePseudoConsole(_hpc);
    }

    public async ValueTask<int> ReadAsync(Memory<byte> buf, CancellationToken ct)
    {
        var b = _rest;
        _rest = null;
        if (b is null)
        {
            if (!await _out.Reader.WaitToReadAsync(ct)) return 0;
            b = await _out.Reader.ReadAsync(ct);
        }
        var n = Math.Min(b.Length, buf.Length);
        b.AsSpan(0, n).CopyTo(buf.Span);
        if (n < b.Length) _rest = b[n..];
        return n;
    }

    public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        await _input.WriteAsync(data, ct);
        await _input.FlushAsync(ct);
    }

    public void Resize(int cols, int rows)
    {
        if (Volatile.Read(ref _closed) == 0) ResizePseudoConsole(_hpc, new Coord((short)cols, (short)rows));
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        if (ExitCode is null) TerminateProcess(_process, 1);
        // 止めたプロセスの終わりを待つ(WaitExit が終了コードを取って ConPTY を閉じる)。
        // ClosePseudoConsole は古い Windows で出力が読まれるまで待つことがあるが、出力は ReadLoop が読み続けている
        await Settle(_exited);
        await Task.Run(ClosePty);
        await _input.DisposeAsync();
        await Settle(_reader);
        await _output.DisposeAsync();
        _job.Dispose();
        _process.Dispose();
        _attached?.Dispose();
    }

    static async Task Settle(Task t)
    {
        try { await t.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (TimeoutException) { }
    }

    sealed class ProcessWaitHandle : WaitHandle
    {
        public ProcessWaitHandle(SafeFileHandle process) => SafeWaitHandle = new SafeWaitHandle(process.DangerousGetHandle(), ownsHandle: false);
    }

    // ---- Win32 ----

    const uint ExtendedStartupInfoPresent = 0x00080000;
    const uint CreateSuspended = 0x00000004;
    const int StartfUseStdHandles = 0x00000100;
    const nint ProcThreadAttributePseudoConsole = 0x00020016;
    const int JobObjectExtendedLimitInformationClass = 9;
    const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    readonly struct Coord(short x, short y)
    {
        public readonly short X = x;
        public readonly short Y = y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int cb;
        public nint lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public nint lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public nint hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, nint lpPipeAttributes, int nSize);

    [LibraryImport("kernel32.dll")]
    private static partial int CreatePseudoConsole(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out nint phPC);

    [LibraryImport("kernel32.dll")]
    private static partial int ResizePseudoConsole(nint hPC, Coord size);

    [LibraryImport("kernel32.dll")]
    private static partial void ClosePseudoConsole(nint hPC);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool InitializeProcThreadAttributeList(nint lpAttributeList, int dwAttributeCount, int dwFlags, ref nint lpSize);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UpdateProcThreadAttribute(nint lpAttributeList, uint dwFlags, nint attribute, nint lpValue, nint cbSize, nint lpPreviousValue, nint lpReturnSize);

    [LibraryImport("kernel32.dll")]
    private static partial void DeleteProcThreadAttributeList(nint lpAttributeList);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool CreateProcessW(string? lpApplicationName, char* lpCommandLine, nint lpProcessAttributes, nint lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles, uint dwCreationFlags, nint lpEnvironment, string? lpCurrentDirectory,
        StartupInfoEx* lpStartupInfo, ProcessInformation* lpProcessInformation);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateJobObjectW(nint lpJobAttributes, string? lpName);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool SetInformationJobObject(SafeFileHandle hJob, int infoClass, void* info, int length);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AssignProcessToJobObject(SafeFileHandle hJob, SafeFileHandle hProcess);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint ResumeThread(SafeFileHandle hThread);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TerminateProcess(SafeFileHandle hProcess, uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(SafeFileHandle hProcess, out uint exitCode);
}

/// <summary>
/// 復号した talosconfig を talosctl に渡す名前付きパイプ。`--talosconfig \\.\pipe\mado-talos-&lt;乱数&gt;` で読ませ、ディスクには書かない。
///
/// - パイプの ACL は mado のアカウント(サービスなら SYSTEM)だけ(PipeOptions.CurrentUserOnly)
/// - つないできた相手のプロセス ID が、動かした talosctl のものでなければ渡さない
/// - talosctl(Go)は読む前に os.Stat でも 1 度開くので、口をいくつか同時に開けておく
/// - 30 秒たつか、全部の口が使われたら閉じ、中身を 0 で消す
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed partial class ConfigPipe : IDisposable
{
    const int Instances = 4;
    static readonly TimeSpan Window = TimeSpan.FromSeconds(30);

    readonly byte[] _content;
    readonly TaskCompletionSource<int> _pid = new(TaskCreationOptions.RunContinuationsAsynchronously);
    readonly CancellationTokenSource _stop = new(Window);
    readonly Action<string> _log;
    int _left = Instances;

    public string Path { get; }

    ConfigPipe(byte[] content, string name, Action<string> log)
    {
        _content = content;
        _log = log;
        Path = $@"\\.\pipe\{name}";
    }

    public static ConfigPipe Start(byte[] content, Action<string> log)
    {
        var name = $"mado-talos-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16))}";
        var p = new ConfigPipe(content, name, log);
        // 口は先に全部作る(talosctl が開くときに空いていないと「All pipe instances are busy」で落ちる)
        var servers = new List<NamedPipeServerStream>();
        try
        {
            for (var i = 0; i < Instances; i++)
                servers.Add(new NamedPipeServerStream(name, PipeDirection.Out, Instances, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly));
        }
        catch
        {
            foreach (var s in servers) s.Dispose();
            CryptographicOperations.ZeroMemory(content);
            throw;
        }
        foreach (var s in servers) _ = p.Serve(s);
        return p;
    }

    /// <summary>渡してよい相手(動かした talosctl)のプロセス ID</summary>
    public void Allow(int pid) => _pid.TrySetResult(pid);

    async Task Serve(NamedPipeServerStream s)
    {
        try
        {
            await s.WaitForConnectionAsync(_stop.Token);
            var pid = await _pid.Task.WaitAsync(_stop.Token);
            if (!GetNamedPipeClientProcessId(s.SafePipeHandle, out var client) || client != pid)
            {
                _log($"talosconfig pipe: 知らないプロセス ({client}) が開いたので渡さない");
                return;
            }
            await s.WriteAsync(_content, _stop.Token);
            await s.FlushAsync(_stop.Token);
            s.WaitForPipeDrain();
        }
        // 相手が読まずに閉じた(os.Stat)、時間切れ、閉じた
        catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException) { }
        finally
        {
            await s.DisposeAsync();
            if (Interlocked.Decrement(ref _left) == 0) Dispose();
        }
    }

    public void Dispose()
    {
        _pid.TrySetCanceled();
        try { _stop.Cancel(); }
        catch (ObjectDisposedException) { }
        CryptographicOperations.ZeroMemory(_content);
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
}

/// <summary>DPAPI(CryptProtectData / CryptUnprotectData)。保護は試験と、手元で作るとき用</summary>
[SupportedOSPlatform("windows")]
internal static unsafe partial class Dpapi
{
    const int UiForbidden = 0x1;
    const int LocalMachine = 0x4;

    public static byte[] Unprotect(byte[] blob) => Call(blob, protect: false, localMachine: false);

    /// <summary>LocalMachine の範囲で保護する(その PC のどのアカウントでも開ける。読める人はファイルの ACL で絞る)</summary>
    public static byte[] Protect(byte[] plain, bool localMachine = true) => Call(plain, protect: true, localMachine);

    static byte[] Call(byte[] input, bool protect, bool localMachine)
    {
        fixed (byte* p = input)
        {
            var inBlob = new DataBlob { cbData = input.Length, pbData = (nint)p };
            DataBlob outBlob = default;
            var flags = UiForbidden | (localMachine ? LocalMachine : 0);
            var ok = protect
                ? CryptProtectData(&inBlob, 0, null, 0, 0, flags, &outBlob)
                : CryptUnprotectData(&inBlob, 0, null, 0, 0, flags, &outBlob);
            if (!ok) throw new CryptographicException(Marshal.GetLastPInvokeError());
            try { return new Span<byte>((void*)outBlob.pbData, outBlob.cbData).ToArray(); }
            finally
            {
                new Span<byte>((void*)outBlob.pbData, outBlob.cbData).Clear();
                LocalFree(outBlob.pbData);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DataBlob
    {
        public int cbData;
        public nint pbData;
    }

    [LibraryImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CryptProtectData(DataBlob* dataIn, nint description, DataBlob* entropy, nint reserved, nint prompt, int flags, DataBlob* dataOut);

    [LibraryImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CryptUnprotectData(DataBlob* dataIn, nint description, DataBlob* entropy, nint reserved, nint prompt, int flags, DataBlob* dataOut);

    [LibraryImport("kernel32.dll")]
    private static partial nint LocalFree(nint mem);
}
