using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mado;

/// <summary>
/// AMT の先の Talos のダッシュボードの設定(mado.json の targets[].talos)。
/// Talosconfig は DPAPI で保護した talosconfig の場所(os:reader の役割だけのもの)。Talosctl が無ければ PATH から探す
/// </summary>
internal sealed partial record TalosOptions(string Talosconfig, string Node, IReadOnlyList<string> Endpoints, string? Talosctl = null)
{
    /// <summary>node と endpoints に書けるもの。IPv4 / IPv6 のアドレスかホスト名で、- で始まらない(talosctl のフラグと読まれない)</summary>
    public static bool IsHost(string s) => HostRe().IsMatch(s);
}

/// <summary>talosctl を動かすときのコマンド。ブラウザからは何も渡らず、全部 mado.json から作る</summary>
internal static class TalosCommand
{
    /// <summary>
    /// talosctl に渡す引数。いつも `--talosconfig &lt;設定&gt; --nodes &lt;node&gt; --endpoints &lt;endpoints&gt; dashboard` の形。
    /// configPath は talosconfig を渡す名前付きパイプ(TalosSecret、ConfigPipe)
    /// </summary>
    public static IReadOnlyList<string> Arguments(TalosOptions o, string configPath) =>
        ["--talosconfig", configPath, "--nodes", o.Node, "--endpoints", string.Join(',', o.Endpoints), "dashboard"];

    /// <summary>
    /// CreateProcess に渡す 1 行。exe も引数も、CommandLineToArgvW が元の値に戻せるように囲む
    /// (空白か " を含むものだけを "" で囲み、" の前と、閉じの " の前の \ を倍にする)
    /// </summary>
    public static string CommandLine(string exe, IEnumerable<string> args) =>
        string.Join(' ', new[] { exe }.Concat(args).Select(Quote));

    internal static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0) return s;
        var b = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in s)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1);
            else b.Append('\\', slashes);
            slashes = 0;
            b.Append(c);
        }
        b.Append('\\', slashes * 2);
        return b.Append('"').ToString();
    }

    /// <summary>talosctl の場所。設定に書いてあればそこ(無ければ null)、無ければ PATH の中の talosctl.exe</summary>
    public static string? FindTalosctl(TalosOptions o, string? path, Func<string, bool> exists)
    {
        if (o.Talosctl is not null) return exists(o.Talosctl) ? o.Talosctl : null;
        var name = OperatingSystem.IsWindows() ? "talosctl.exe" : "talosctl";
        foreach (var dir in (path ?? "").Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            // 相対の PATH(. など)はサービスの作業フォルダ次第になるので見ない
            if (!System.IO.Path.IsPathFullyQualified(dir)) continue;
            var p = System.IO.Path.Combine(dir, name);
            if (exists(p)) return p;
        }
        return null;
    }
}

/// <summary>
/// DPAPI で保護した talosconfig を開く。鍵は LocalMachine の範囲で保護してあり(gitops の mado/setup.ps1)、
/// ファイルの ACL(SYSTEM と Administrators だけ)で読める人を絞る。復号した中身はメモリにだけ置き、名前付きパイプで talosctl に渡す
/// </summary>
internal static partial class TalosSecret
{
    /// <summary>復号した talosconfig。Windows でしか開けない</summary>
    public static byte[] Read(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI は Windows だけ");
        var blob = File.ReadAllBytes(path);
        try { return Dpapi.Unprotect(blob); }
        finally { CryptographicOperations.ZeroMemory(blob); }
    }

    /// <summary>
    /// talosconfig のクライアント証明書の期限。使う context(先頭の `context:`)の crt を読み、その名前の段が見つからなければ最初の crt。
    /// talosctl config new が書くのは context が 1 つの形。読めなければ null
    /// </summary>
    public static DateTimeOffset? NotAfter(ReadOnlySpan<byte> talosconfig)
    {
        var text = Encoding.UTF8.GetString(talosconfig);
        var start = 0;
        // 段は contexts: の下だけで探す(ca や crt のような名前の context でも、ほかの項目に当たらない)
        if (CurrentRe().Match(text) is { Success: true } cur
            && ContextsRe().Match(text) is { Success: true } contexts
            && new Regex($@"(?m)^\s+{Regex.Escape(cur.Groups[1].Value)}:\s*$").Match(text, contexts.Index + contexts.Length) is { Success: true } section)
            start = section.Index + section.Length;
        var m = CrtRe().Match(text, start);
        if (!m.Success) return null;
        try
        {
            var pem = Encoding.ASCII.GetString(Convert.FromBase64String(m.Groups[1].Value));
            var found = PemEncoding.Find(pem);
            if (pem[found.Label] != "CERTIFICATE") return null;
            using var cert = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(pem[found.Base64Data]));
            return new DateTimeOffset(cert.NotAfter.ToUniversalTime(), TimeSpan.Zero);
        }
        catch (Exception e) when (e is FormatException or ArgumentException or CryptographicException) { return null; }
    }

    // ファイルが変わったとき(setup.ps1 で作り直したとき)だけ読み直す
    static readonly Lock Gate = new();
    static readonly Dictionary<string, (DateTime Written, DateTimeOffset? NotAfter)> Cache = [];

    /// <summary>画面に出す期限。ファイルの更新時刻が同じあいだは覚えておく。開けなければ null</summary>
    public static DateTimeOffset? NotAfterOf(string path)
    {
        if (!OperatingSystem.IsWindows()) return null;
        DateTime written;
        try { written = File.GetLastWriteTimeUtc(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
        lock (Gate)
            if (Cache.TryGetValue(path, out var c) && c.Written == written) return c.NotAfter;
        DateTimeOffset? notAfter = null;
        try
        {
            var plain = Read(path);
            try { notAfter = NotAfter(plain); }
            finally { CryptographicOperations.ZeroMemory(plain); }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException) { }
        lock (Gate) Cache[path] = (written, notAfter);
        return notAfter;
    }

    [GeneratedRegex(@"(?m)^\s*crt:\s*[""']?([A-Za-z0-9+/=]+)[""']?\s*$")]
    private static partial Regex CrtRe();

    [GeneratedRegex(@"(?m)^context:\s*[""']?([^\s""']+)[""']?\s*$")]
    private static partial Regex CurrentRe();

    [GeneratedRegex(@"(?m)^contexts:\s*$")]
    private static partial Regex ContextsRe();
}

/// <summary>talosctl を動かせなかった。Reason は WebSocket を閉じる理由(短い英語。画面が日本語にする)</summary>
internal sealed class TalosStartException(string reason, string? detail = null) : Exception(detail is null ? reason : $"{reason} ({detail})")
{
    public string Reason { get; } = reason;
}

/// <summary>擬似端末で動かしているもの。ConPty(Windows)と、試験の偽物</summary>
internal interface ITerminal : IAsyncDisposable
{
    /// <summary>画面に出すバイト。0 は終わった(プロセスが終わり、出力を出し切った)</summary>
    ValueTask<int> ReadAsync(Memory<byte> buf, CancellationToken ct);
    /// <summary>キー入力</summary>
    ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct);
    void Resize(int cols, int rows);
    /// <summary>終わっていれば終了コード</summary>
    int? ExitCode { get; }
}

/// <summary>端末を始める。talos は設定の値で、ブラウザから来るのは大きさだけ</summary>
internal delegate Task<ITerminal> TerminalStarter(TalosOptions talos, int cols, int rows, CancellationToken ct);

/// <summary>
/// Talos のダッシュボード(`talosctl dashboard`)の中継。ブラウザは WebSocket(/ws/talos)で来る。
///
/// 1. 最初にテキストで {"token": "...", "cols": 120, "rows": 40} を送る。token は /api/token の使い捨てのもの。
///    トークンの中の先が AMT で、talos の設定があるときだけ続ける
/// 2. mado が talosctl を擬似端末(ConPTY)で動かす。引数は mado.json の値だけで決まる(TalosCommand)
/// 3. あとはバイナリが端末の入出力。テキストの {"cols": .., "rows": ..} は大きさを変える
///
/// 失敗したら WebSocket を理由つきで閉じる。理由は短い英語(WebSocket の理由は 123 バイトまで)。talosctl が終われば "exited &lt;コード&gt;"
/// </summary>
internal static class TalosRelay
{
    public const string Path = "/ws/talos";
    /// <summary>同時に動かす talosctl の数。ログインしている人でも、プロセスをいくらでも増やさせない</summary>
    public const int MaxSessions = 4;
    const int MaxMessage = 64 * 1024;
    static int _active;

    public static async Task Serve(string user, WebSocket ws, Func<string?, Target?> authorize, TerminalStarter start,
        Action<string> log, Action<int> sessions, CancellationToken ct)
    {
        sessions(+1);
        log($"talos open: {user}");
        try
        {
            await Run(ws, authorize, start, m => log($"{user}: {m}"), ct);
        }
        catch (Exception e) when (e is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException) { }
        catch (Exception e)
        {
            log($"{user}: talos relay error: {e.Message}");
        }
        finally
        {
            sessions(-1);
            log($"talos close: {user}");
        }
    }

    public static async Task Run(WebSocket ws, Func<string?, Target?> authorize, TerminalStarter start, Action<string> log,
        CancellationToken ct, TimeSpan? helloTimeout = null)
    {
        var buf = new byte[MaxMessage];
        TalosHello? hello;
        using (var wait = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            wait.CancelAfter(helloTimeout ?? Relay.RequestTimeout);
            (WebSocketMessageType Type, int Count)? first;
            try { first = await Receive(ws, buf, wait.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // 受信を取り消した WebSocket は閉じる手順を踏めないので、理由は送れない
                log("talos relay failed: hello timeout");
                ws.Abort();
                return;
            }
            if (first is not { } m) return;
            if (m.Type != WebSocketMessageType.Text || m.Count < 0)
            {
                await Fail(ws, m.Count < 0 ? "message too large" : "hello must be text", log);
                return;
            }
            try { hello = JsonSerializer.Deserialize(buf.AsSpan(0, m.Count), ApiJson.Default.TalosHello); }
            catch (JsonException) { hello = null; }
        }
        if (hello is null)
        {
            await Fail(ws, "bad hello", log);
            return;
        }
        if (authorize(hello.Token) is not { Kind: TargetKind.Amt, Talos: { } talos } target)
        {
            await Fail(ws, "token rejected", log);
            return;
        }
        if (Interlocked.Increment(ref _active) > MaxSessions)
        {
            Interlocked.Decrement(ref _active);
            await Fail(ws, "busy", log);
            return;
        }
        try
        {
            ITerminal term;
            try { term = await start(talos, Clamp(hello.Cols, 80), Clamp(hello.Rows, 24), ct); }
            catch (TalosStartException e)
            {
                await Fail(ws, e.Reason, log, e.Message);
                return;
            }
            log($"talos dashboard {target.Name} (node {talos.Node})");
            await using (term)
                await Pump(ws, term, buf, ct);
            var reason = term.ExitCode is { } code ? $"exited {code}" : "closed";
            log($"talos dashboard {target.Name}: {reason}");
        }
        finally
        {
            Interlocked.Decrement(ref _active);
        }
    }

    /// <summary>端末とブラウザのあいだを流す。どちらかが終われば、もう片方も止める</summary>
    static async Task Pump(WebSocket ws, ITerminal term, byte[] buf, CancellationToken ct)
    {
        // 受け取り(up)は ct だけで止める。WebSocket の受信を取り消すと、WebSocket ごと壊れて close を送れなくなるため
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var down = Task.Run(async () =>
        {
            var b = new byte[16 * 1024];
            int n;
            while ((n = await term.ReadAsync(b, stop.Token)) > 0)
                await ws.SendAsync(b.AsMemory(0, n), WebSocketMessageType.Binary, true, stop.Token);
        }, CancellationToken.None);
        var up = Task.Run(async () =>
        {
            while (await Receive(ws, buf, ct) is { } m)
            {
                if (m.Count < 0) return;
                if (m.Type == WebSocketMessageType.Binary)
                {
                    if (m.Count > 0) await term.WriteAsync(buf.AsMemory(0, m.Count), ct);
                    continue;
                }
                TalosResize? r = null;
                try { r = JsonSerializer.Deserialize(buf.AsSpan(0, m.Count), ApiJson.Default.TalosResize); }
                catch (JsonException) { }
                if (r is not null) term.Resize(Clamp(r.Cols, 80), Clamp(r.Rows, 24));
            }
        }, CancellationToken.None);
        var first = await Task.WhenAny(down, up);
        if (first == down)
        {
            // talosctl が終わった。閉じる理由に終了コードを入れる。受け取り側(up)は相手の close を受けて終わる
            await Quiet(down);
            await CloseOutput(ws, term.ExitCode is { } code ? $"exited {code}" : "closed");
            if (await Task.WhenAny(up, Task.Delay(TimeSpan.FromSeconds(5), CancellationToken.None)) != up) ws.Abort();
            await Quiet(up);
        }
        else
        {
            // ブラウザが閉じた(か、大きすぎるメッセージ)。端末は呼び出し側が閉じる(talosctl を止める)
            await Quiet(up);
            await CloseOutput(ws, "");
            await stop.CancelAsync();
            await Quiet(down);
        }
    }

    static async Task Quiet(Task t)
    {
        try { await t; }
        catch (Exception e) when (e is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException or TimeoutException) { }
    }

    /// <summary>1 つのメッセージを buf に読む。閉じたら null。buf に入らなければ大きすぎるとして閉じ、Count を -1 にする</summary>
    static async Task<(WebSocketMessageType Type, int Count)?> Receive(WebSocket ws, byte[] buf, CancellationToken ct)
    {
        var have = 0;
        while (true)
        {
            if (have == buf.Length)
            {
                await CloseOutput(ws, "message too large");
                return (WebSocketMessageType.Binary, -1);
            }
            var r = await ws.ReceiveAsync(buf.AsMemory(have), ct);
            if (r.MessageType == WebSocketMessageType.Close) return null;
            have += r.Count;
            if (r.EndOfMessage) return (r.MessageType, have);
        }
    }

    static int Clamp(int v, int fallback) => v is >= 1 and <= 1000 ? v : fallback;

    static async Task CloseOutput(WebSocket ws, string reason)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, reason, CancellationToken.None);
        }
        catch (Exception e) when (e is IOException or WebSocketException or ObjectDisposedException or InvalidOperationException or OperationCanceledException) { }
    }

    static async Task Fail(WebSocket ws, string reason, Action<string> log, string? detail = null)
    {
        log($"talos relay failed: {detail ?? reason}");
        await CloseOutput(ws, reason);
    }
}

/// <summary>/ws/talos の最初のメッセージ</summary>
internal sealed record TalosHello(
    [property: System.Text.Json.Serialization.JsonPropertyName("token")] string? Token,
    [property: System.Text.Json.Serialization.JsonPropertyName("cols")] int Cols,
    [property: System.Text.Json.Serialization.JsonPropertyName("rows")] int Rows);

/// <summary>/ws/talos の大きさの変更</summary>
internal sealed record TalosResize(
    [property: System.Text.Json.Serialization.JsonPropertyName("cols")] int Cols,
    [property: System.Text.Json.Serialization.JsonPropertyName("rows")] int Rows);

/// <summary>本物の端末。talosctl を ConPTY で動かし、talosconfig は名前付きパイプで渡す</summary>
internal static class TalosTerminal
{
    public static Task<ITerminal> Start(TalosOptions o, int cols, int rows, Action<string> log)
    {
        if (!OperatingSystem.IsWindows()) throw new TalosStartException("not supported", "ConPTY は Windows だけ");
        var exe = TalosCommand.FindTalosctl(o, Environment.GetEnvironmentVariable("PATH"), File.Exists)
            ?? throw new TalosStartException("talosctl not found", o.Talosctl ?? "PATH に talosctl.exe が無い");
        byte[] secret;
        try { secret = TalosSecret.Read(o.Talosconfig); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException)
        {
            throw new TalosStartException("talosconfig unreadable", $"{o.Talosconfig}: {e.Message}");
        }
        // パイプが中身を持ち、渡し終えたら消す
        var pipe = ConfigPipe.Start(secret, log);
        try
        {
            var pty = ConPty.Start(TalosCommand.CommandLine(exe, TalosCommand.Arguments(o, pipe.Path)), cols, rows, pipe);
            pipe.Allow(pty.ProcessId);
            return Task.FromResult<ITerminal>(pty);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException)
        {
            pipe.Dispose();
            throw new TalosStartException("start failed", e.Message);
        }
    }
}

internal sealed partial record TalosOptions
{
    [GeneratedRegex(@"^(?:[A-Za-z0-9][A-Za-z0-9.\-]*|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$")]
    private static partial Regex HostRe();
}
