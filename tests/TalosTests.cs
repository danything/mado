using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Channels;
using TUnit.Core.Enums;

namespace Mado.Tests;

/// <summary>
/// Talos のダッシュボード。設定の読み込み、talosctl に渡すコマンドが固定であること、/ws/talos の中継(偽の端末)、
/// talosconfig の期限。ConPTY・DPAPI・名前付きパイプは Windows でだけ試す
/// </summary>
[NotInParallel("talos-relay")] // 中継の同時の数(TalosRelay の静的な数)を数える試験があるため
public class TalosTests
{
    const string Base = """
        "host": "md.example.com",
        "acme": { "email": "a@example.com" },
        "oidc": { "issuer": "https://idp.example.com", "client_id": "id", "client_secret": "s" }
        """;

    static (Config Config, string Dir) Load(string targets)
    {
        var dir = Directory.CreateTempSubdirectory("mado-talos-").FullName;
        var file = Path.Combine(dir, "mado.json");
        File.WriteAllText(file, $"{{ {Base}, \"targets\": [{targets}] }}");
        return (Config.Load(["--config", file]), dir);
    }

    // ---- 設定 ----

    [Test]
    public async Task talos_は_AMT_の先に書ける()
    {
        var (c, dir) = Load("""{ "name": "z", "type": "amt", "host": "10.10.0.3", "talos": { "talosconfig": "talosconfig.dpapi", "node": "10.10.0.4", "endpoints": ["10.10.0.4", "10.0.0.2"], "talosctl": "bin/talosctl.exe" } }""");
        var t = c.Amt("z")!.Talos!;
        await Assert.That(t.Talosconfig).IsEqualTo(Path.Combine(dir, "talosconfig.dpapi"));
        await Assert.That(t.Node).IsEqualTo("10.10.0.4");
        await Assert.That(t.Endpoints).IsEquivalentTo(["10.10.0.4", "10.0.0.2"]);
        await Assert.That(t.Talosctl).IsEqualTo(Path.GetFullPath("bin/talosctl.exe", dir));
    }

    [Test]
    public async Task endpoints_の既定は_node_で_talosctl_の既定は_PATH()
    {
        var (c, _) = Load("""{ "name": "z", "type": "amt", "host": "10.10.0.3", "talos": { "talosconfig": "t", "node": "fd00::4" } }""");
        var t = c.Amt("z")!.Talos!;
        await Assert.That(t.Endpoints).IsEquivalentTo(["fd00::4"]);
        await Assert.That(t.Talosctl).IsNull();
    }

    [Test]
    public async Task talos_が無い先には出さない()
    {
        var (c, _) = Load("""{ "name": "z", "type": "amt", "host": "10.10.0.3" }""");
        await Assert.That(c.Amt("z")!.Talos).IsNull();
    }

    [Test]
    [Arguments("""{ "host": "10.0.0.1", "talos": { "talosconfig": "t", "node": "n" } }""", "type が amt のときだけ")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "node": "n" } }""", "talosconfig が要る")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t" } }""", "node が要る")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t", "node": "--help" } }""", "アドレスかホスト名")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t", "node": "a b" } }""", "アドレスかホスト名")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t", "node": "n", "endpoints": [] } }""", "1 つ以上")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t", "node": "n", "endpoints": ["-e"] } }""", "アドレスかホスト名の配列")]
    [Arguments("""{ "type": "amt", "host": "h", "talos": { "talosconfig": "t", "node": "n", "talosctl": "" } }""", "talosctl は空でない")]
    public async Task talos_の間違いは起動時に止める(string target, string message)
    {
        var e = Assert.Throws<ConfigException>(() => Load(target));
        await Assert.That(e.Message).Contains(message);
    }

    [Test]
    public async Task 知らない項目は読み飛ばす()
    {
        // 古い mado に新しい mado.json を渡しても落ちない(System.Text.Json の既定)。talos を知らない版でも同じ
        var (c, _) = Load("""{ "name": "z", "type": "amt", "host": "10.10.0.3", "someday": { "x": 1 } }""");
        await Assert.That(c.Amt("z")).IsNotNull();
    }

    // ---- コマンド ----

    [Test]
    public async Task コマンドはいつも同じ形()
    {
        var o = new TalosOptions(@"C:\ProgramData\mado\talosconfig.dpapi", "10.10.0.4", ["10.10.0.4", "10.0.0.2"]);
        var args = TalosCommand.Arguments(o, @"\\.\pipe\mado-talos-0123");
        await Assert.That(args).IsEquivalentTo(
            ["--talosconfig", @"\\.\pipe\mado-talos-0123", "--nodes", "10.10.0.4", "--endpoints", "10.10.0.4,10.0.0.2", "dashboard"]);
        await Assert.That(TalosCommand.CommandLine(@"C:\Program Files\talos\talosctl.exe", args)).IsEqualTo(
            @"""C:\Program Files\talos\talosctl.exe"" --talosconfig \\.\pipe\mado-talos-0123 --nodes 10.10.0.4 --endpoints 10.10.0.4,10.0.0.2 dashboard");
    }

    [Test]
    [Arguments("a", "a")]
    [Arguments("", "\"\"")]
    [Arguments("a b", "\"a b\"")]
    [Arguments("say \"hi\"", "\"say \\\"hi\\\"\"")]
    [Arguments(@"C:\dir with space\", @"""C:\dir with space\\""")]
    [Arguments(@"a\\""b", @"""a\\\\\""b""")]
    public async Task 引数は_CommandLineToArgvW_で戻る形に囲む(string arg, string quoted)
    {
        await Assert.That(TalosCommand.Quote(arg)).IsEqualTo(quoted);
    }

    [Test]
    public async Task talosctl_は設定の場所か_PATH_から探す()
    {
        var name = OperatingSystem.IsWindows() ? "talosctl.exe" : "talosctl";
        var bin = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "bin"));
        var have = Path.Combine(bin, name);
        var path = string.Join(Path.PathSeparator, ".", Path.GetFullPath(Path.Combine(Path.GetTempPath(), "none")), bin);
        var o = new TalosOptions("t", "n", ["n"]);
        await Assert.That(TalosCommand.FindTalosctl(o, path, p => p == have)).IsEqualTo(have);
        // 相対の PATH は見ない
        await Assert.That(TalosCommand.FindTalosctl(o, ".", p => true)).IsNull();
        await Assert.That(TalosCommand.FindTalosctl(o, null, p => true)).IsNull();
        // 設定に書いてあれば PATH は見ない
        var set = o with { Talosctl = Path.Combine(bin, "x.exe") };
        await Assert.That(TalosCommand.FindTalosctl(set, path, p => p == have)).IsNull();
        await Assert.That(TalosCommand.FindTalosctl(set, path, p => true)).IsEqualTo(set.Talosctl);
    }

    // ---- 期限 ----

    /// <summary>talosctl config new が書く形の talosconfig(証明書は自己署名)</summary>
    static byte[] Talosconfig(DateTimeOffset notAfter)
    {
        using var key = ECDsa.Create();
        var req = new CertificateRequest("O=os:reader", key, HashAlgorithmName.SHA256);
        using var cert = req.CreateSelfSigned(notAfter.AddDays(-90), notAfter);
        string B64(string s) => Convert.ToBase64String(Encoding.ASCII.GetBytes(s));
        return Encoding.UTF8.GetBytes(
            $"context: doany\ncontexts:\n    doany:\n        endpoints:\n            - 10.10.0.4\n        nodes:\n            - 10.10.0.4\n" +
            $"        ca: {B64(cert.ExportCertificatePem())}\n        crt: {B64(cert.ExportCertificatePem())}\n        key: {B64(key.ExportPkcs8PrivateKeyPem())}\n");
    }

    [Test]
    public async Task 期限は_crt_の_NotAfter()
    {
        var until = new DateTimeOffset(2027, 1, 31, 12, 0, 0, TimeSpan.Zero);
        await Assert.That(TalosSecret.NotAfter(Talosconfig(until))).IsEqualTo(until);
        await Assert.That(TalosSecret.NotAfter("context: x\n"u8)).IsNull();
        await Assert.That(TalosSecret.NotAfter("crt: bm90IGEgY2VydA==\n"u8)).IsNull();
    }

    [Test]
    public async Task 期限は使う_context_の_crt()
    {
        var first = Encoding.UTF8.GetString(Talosconfig(new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero)));
        var second = Encoding.UTF8.GetString(Talosconfig(new DateTimeOffset(2027, 6, 1, 0, 0, 0, TimeSpan.Zero)));
        string Section(string yaml, string name) =>
            yaml[(yaml.IndexOf("    doany:\n", StringComparison.Ordinal) + "    doany:\n".Length)..].Insert(0, $"    {name}:\n");
        var both = $"context: other\ncontexts:\n{Section(first, "doany")}{Section(second, "other")}";
        await Assert.That(TalosSecret.NotAfter(Encoding.UTF8.GetBytes(both))).IsEqualTo(new DateTimeOffset(2027, 6, 1, 0, 0, 0, TimeSpan.Zero));
        // 項目と同じ名前(ca)の context でも、contexts: の下の段を読む
        var named = $"context: ca\ncontexts:\n{Section(first, "doany")}{Section(second, "ca")}";
        await Assert.That(TalosSecret.NotAfter(Encoding.UTF8.GetBytes(named))).IsEqualTo(new DateTimeOffset(2027, 6, 1, 0, 0, 0, TimeSpan.Zero));
        // 名前の段が無ければ最初の crt
        await Assert.That(TalosSecret.NotAfter(Encoding.UTF8.GetBytes(both.Replace("context: other", "context: none"))))
            .IsEqualTo(new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero));
    }

    // ---- 中継 ----

    sealed class FakeTerminal : ITerminal
    {
        public readonly Channel<byte[]> Output = Channel.CreateUnbounded<byte[]>();
        public readonly Channel<byte[]> Input = Channel.CreateUnbounded<byte[]>();
        public readonly Channel<(int, int)> Sizes = Channel.CreateUnbounded<(int, int)>();
        public bool Disposed;
        public int? ExitCode { get; set; }

        public async ValueTask<int> ReadAsync(Memory<byte> buf, CancellationToken ct)
        {
            if (!await Output.Reader.WaitToReadAsync(ct)) return 0;
            var b = await Output.Reader.ReadAsync(ct);
            b.CopyTo(buf);
            return b.Length;
        }

        public ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
        {
            Input.Writer.TryWrite(data.ToArray());
            return ValueTask.CompletedTask;
        }

        public void Resize(int cols, int rows) => Sizes.Writer.TryWrite((cols, rows));

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>手元の TCP の上に WebSocket の両端を作る(HTTP の握手は省く)</summary>
    static async Task<(WebSocket Server, WebSocket Client)> WebSocketPair()
    {
        using var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var client = new TcpClient();
        var connect = client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)l.LocalEndpoint).Port);
        var server = await l.AcceptTcpClientAsync();
        await connect;
        return (
            WebSocket.CreateFromStream(server.GetStream(), new WebSocketCreationOptions { IsServer = true }),
            WebSocket.CreateFromStream(client.GetStream(), new WebSocketCreationOptions { IsServer = false }));
    }

    static Task SendText(WebSocket ws, string s) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(s), WebSocketMessageType.Text, true, CancellationToken.None);

    /// <summary>閉じるまで読み、届いたバイナリと閉じた理由を返す</summary>
    static async Task<(string Data, string? Reason)> ReadAll(WebSocket ws)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var data = new MemoryStream();
        var buf = new byte[4096];
        while (true)
        {
            var r = await ws.ReceiveAsync(buf, cts.Token);
            if (r.MessageType == WebSocketMessageType.Close)
            {
                if (ws.State == WebSocketState.CloseReceived)
                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", cts.Token);
                return (Encoding.UTF8.GetString(data.ToArray()), ws.CloseStatusDescription);
            }
            data.Write(buf, 0, r.Count);
        }
    }

    static readonly TalosOptions Opts = new("t", "10.10.0.4", ["10.10.0.4"]);
    static readonly Target WithTalos = new("z", "10.10.0.3", Target.AmtHttp, TargetKind.Amt, Talos: Opts);

    [Test]
    public async Task トークンの先が_Talos_の_AMT_なら端末を動かして流す()
    {
        var (server, client) = await WebSocketPair();
        var term = new FakeTerminal();
        (TalosOptions, int, int)? started = null;
        string? seen = null;
        var run = TalosRelay.Run(server, t => { seen = t; return WithTalos; }, (o, c, r, _) =>
        {
            started = (o, c, r);
            return Task.FromResult<ITerminal>(term);
        }, _ => { }, CancellationToken.None);

        await SendText(client, """{"token":"tok","cols":120,"rows":40}""");
        await client.SendAsync("ls\r"u8.ToArray(), WebSocketMessageType.Binary, true, CancellationToken.None);
        await SendText(client, """{"cols":100,"rows":30}""");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await Assert.That(Encoding.ASCII.GetString(await term.Input.Reader.ReadAsync(cts.Token))).IsEqualTo("ls\r");
        await Assert.That(await term.Sizes.Reader.ReadAsync(cts.Token)).IsEqualTo((100, 30));
        await Assert.That(seen).IsEqualTo("tok");
        await Assert.That(started).IsEqualTo((Opts, 120, 40));

        term.Output.Writer.TryWrite("dashboard"u8.ToArray());
        term.ExitCode = 0;
        term.Output.Writer.TryComplete();
        var (data, reason) = await ReadAll(client);
        await run.WaitAsync(cts.Token);
        await Assert.That(data).IsEqualTo("dashboard");
        await Assert.That(reason).IsEqualTo("exited 0");
        await Assert.That(term.Disposed).IsTrue();
    }

    [Test]
    public async Task ブラウザが閉じたら端末を閉じる()
    {
        var (server, client) = await WebSocketPair();
        var term = new FakeTerminal();
        var run = TalosRelay.Run(server, _ => WithTalos, (_, _, _, _) => Task.FromResult<ITerminal>(term), _ => { }, CancellationToken.None);
        await SendText(client, """{"token":"tok","cols":80,"rows":24}""");
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(term.Disposed).IsTrue();
    }

    [Test]
    [Arguments("rdp")]
    [Arguments("amt")]
    [Arguments("none")]
    public async Task Talos_の無い先のトークンでは動かさない(string kind)
    {
        var (server, client) = await WebSocketPair();
        Target? target = kind switch
        {
            "rdp" => new Target("pc", "10.0.0.1", 3389, Talos: Opts),
            "amt" => new Target("z", "10.10.0.3", Target.AmtHttp, TargetKind.Amt),
            _ => null,
        };
        var started = false;
        var run = TalosRelay.Run(server, _ => target, (_, _, _, _) =>
        {
            started = true;
            return Task.FromResult<ITerminal>(new FakeTerminal());
        }, _ => { }, CancellationToken.None);
        await SendText(client, """{"token":"tok","cols":80,"rows":24}""");
        var (_, reason) = await ReadAll(client);
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(reason).IsEqualTo("token rejected");
        await Assert.That(started).IsFalse();
    }

    [Test]
    [Arguments("not json", "bad hello")]
    [Arguments("null", "bad hello")]
    public async Task 最初のメッセージが読めなければ閉じる(string hello, string expected)
    {
        var (server, client) = await WebSocketPair();
        var run = TalosRelay.Run(server, _ => WithTalos, (_, _, _, _) => Task.FromResult<ITerminal>(new FakeTerminal()), _ => { }, CancellationToken.None);
        await SendText(client, hello);
        var (_, reason) = await ReadAll(client);
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(reason).IsEqualTo(expected);
    }

    [Test]
    public async Task 最初のメッセージはテキスト()
    {
        var (server, client) = await WebSocketPair();
        var run = TalosRelay.Run(server, _ => WithTalos, (_, _, _, _) => Task.FromResult<ITerminal>(new FakeTerminal()), _ => { }, CancellationToken.None);
        await client.SendAsync("tok\n"u8.ToArray(), WebSocketMessageType.Binary, true, CancellationToken.None);
        var (_, reason) = await ReadAll(client);
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(reason).IsEqualTo("hello must be text");
    }

    [Test]
    public async Task 同時に動かすのは上限まで()
    {
        var open = new List<(WebSocket Client, FakeTerminal Term, Task Run)>();
        for (var i = 0; i < TalosRelay.MaxSessions; i++)
        {
            var (server, client) = await WebSocketPair();
            var term = new FakeTerminal();
            var started = new TaskCompletionSource();
            var run = TalosRelay.Run(server, _ => WithTalos, (_, _, _, _) =>
            {
                started.SetResult();
                return Task.FromResult<ITerminal>(term);
            }, _ => { }, CancellationToken.None);
            await SendText(client, """{"token":"tok","cols":80,"rows":24}""");
            await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            open.Add((client, term, run));
        }
        var (s5, c5) = await WebSocketPair();
        var run5 = TalosRelay.Run(s5, _ => WithTalos, (_, _, _, _) => Task.FromResult<ITerminal>(new FakeTerminal()), _ => { }, CancellationToken.None);
        await SendText(c5, """{"token":"tok","cols":80,"rows":24}""");
        await Assert.That((await ReadAll(c5)).Reason).IsEqualTo("busy");
        await run5.WaitAsync(TimeSpan.FromSeconds(10));
        foreach (var (client, term, run) in open)
        {
            term.Output.Writer.TryComplete();
            await ReadAll(client);
            await run.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    [Test]
    public async Task 動かせなければ理由を返す()
    {
        var (server, client) = await WebSocketPair();
        var run = TalosRelay.Run(server, _ => WithTalos,
            (_, _, _, _) => throw new TalosStartException("talosctl not found", "PATH"), _ => { }, CancellationToken.None);
        await SendText(client, """{"token":"tok","cols":80,"rows":24}""");
        var (_, reason) = await ReadAll(client);
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(reason).IsEqualTo("talosctl not found");
    }

    // ---- Windows だけ ----

    [Test]
    [RunOn(OS.Windows)]
    public async Task DPAPI_で保護したものを開ける()
    {
        if (!OperatingSystem.IsWindows()) return;
        var plain = Talosconfig(DateTimeOffset.UtcNow.AddDays(90));
        var file = Path.Combine(Directory.CreateTempSubdirectory("mado-talos-").FullName, "talosconfig.dpapi");
        File.WriteAllBytes(file, Dpapi.Protect([.. plain]));
        await Assert.That(File.ReadAllBytes(file).AsSpan().IndexOf("crt:"u8)).IsEqualTo(-1);
        await Assert.That(TalosSecret.Read(file)).IsEquivalentTo(plain);
        await Assert.That(TalosSecret.NotAfterOf(file)).IsNotNull();
    }

    [Test]
    [RunOn(OS.Windows)]
    public async Task ConPTY_で動かしたプロセスの出力が届き_終了コードが取れる()
    {
        if (!OperatingSystem.IsWindows()) return;
        await using var pty = ConPty.Start("cmd.exe /d /c echo mado-conpty& exit 3", 80, 24);
        var text = await ReadToEnd(pty);
        await Assert.That(text).Contains("mado-conpty");
        await Assert.That(pty.ExitCode).IsEqualTo(3);
    }

    [Test]
    [RunOn(OS.Windows)]
    public async Task talosconfig_は名前付きパイプで動かしたプロセスにだけ渡す()
    {
        if (!OperatingSystem.IsWindows()) return;
        var secret = "context: mado-pipe-test\n"u8.ToArray();
        var pipe = ConfigPipe.Start([.. secret], _ => { });
        // ほかのプロセス(ここでは試験自身)が先に開いても渡さず、切って同じ口で待ち直す(1 つは動かすプロセスに残す)
        var others = new List<System.IO.Pipes.NamedPipeClientStream>();
        for (var i = 0; i < 3; i++)
        {
            var o = new System.IO.Pipes.NamedPipeClientStream(".", pipe.Path[@"\.\pipe\".Length..], System.IO.Pipes.PipeDirection.In);
            await o.ConnectAsync(5000);
            others.Add(o);
        }
        // 動かしたプロセス(cmd の type)は読める
        await using var pty = ConPty.Start($"cmd.exe /d /c type {pipe.Path}", 200, 24, pipe);
        pipe.Allow(pty.ProcessId);
        foreach (var o in others)
        {
            await Assert.That(await o.ReadAsync(new byte[64]).AsTask().WaitAsync(TimeSpan.FromSeconds(5))).IsEqualTo(0);
            o.Dispose();
        }
        await Assert.That(await ReadToEnd(pty)).Contains("mado-pipe-test");
    }

    static async Task<string> ReadToEnd(ITerminal t)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var all = new MemoryStream();
        var b = new byte[4096];
        int n;
        while ((n = await t.ReadAsync(b, cts.Token)) > 0) all.Write(b, 0, n);
        return Encoding.UTF8.GetString(all.ToArray());
    }
}
