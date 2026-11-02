using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace Mado.Tests;

/// <summary>
/// AMT の中継。WS-Man は偽の AMT(Digest を確かめる HTTP)に送り、Authorization と WWW-Authenticate がそのまま通ることを見る。
/// SOL(リダイレクト)は最初の行のトークンで先を決め、そのあとのバイトが両方向に流れることを見る
/// </summary>
public class AmtTests
{
    const string User = "admin", Pass = "P@ssw0rd!", Realm = "Digest:0123456789ABCDEF";

    static string Md5(string s) => Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes(s)));

    static Dictionary<string, string> DigestParams(string header)
    {
        var d = new Dictionary<string, string>();
        foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(
            header["Digest ".Length..], "(\\w+)=(?:\"([^\"]*)\"|([^,\\s]*))"))
            d[m.Groups[1].Value] = m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
        return d;
    }

    /// <summary>試験側で Digest の応答を作る(ブラウザの web/amt/digest.ts と同じ計算)</summary>
    static string Authorization(string nonce, string password, int nc = 1)
    {
        var ncs = nc.ToString("x8");
        var resp = Md5($"{Md5($"{User}:{Realm}:{password}")}:{nonce}:{ncs}:cnonce1:auth:{Md5("POST:/wsman")}");
        return $"Digest username=\"{User}\", realm=\"{Realm}\", nonce=\"{nonce}\", uri=\"/wsman\", response=\"{resp}\", qop=auth, nc={ncs}, cnonce=\"cnonce1\"";
    }

    /// <summary>偽の AMT の WS-Man。1 本の接続で 1 つの要求に答える。見た Authorization と本文を残す</summary>
    sealed class FakeAmtHttp : IDisposable
    {
        public readonly TcpListener Listener = new(IPAddress.Loopback, 0);
        public readonly string Nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        public readonly List<string?> Authorizations = [];
        public readonly List<string> Paths = [];
        public string ResponseBody = "<Envelope>ok</Envelope>";
        readonly Task _loop;

        public FakeAmtHttp()
        {
            Listener.Start();
            _loop = Task.Run(Loop);
        }

        public int Port => ((IPEndPoint)Listener.LocalEndpoint).Port;

        async Task Loop()
        {
            while (true)
            {
                TcpClient c;
                try { c = await Listener.AcceptTcpClientAsync(); }
                catch (Exception) { return; }
                _ = Task.Run(() => Serve(c));
            }
        }

        async Task Serve(TcpClient c)
        {
            using var _ = c;
            var s = c.GetStream();
            while (true)
            {
                // 頭を読む
                var head = new List<byte>();
                while (head.Count < 4 || !(head[^4] == '\r' && head[^3] == '\n' && head[^2] == '\r' && head[^1] == '\n'))
                {
                    var b = s.ReadByte();
                    if (b < 0) return;
                    head.Add((byte)b);
                }
                var lines = Encoding.ASCII.GetString([.. head]).Split("\r\n");
                Paths.Add(lines[0].Split(' ')[1]);
                var headers = lines.Skip(1).Where(l => l.Contains(':'))
                    .ToDictionary(l => l[..l.IndexOf(':')].ToLowerInvariant(), l => l[(l.IndexOf(':') + 1)..].Trim());
                var len = int.Parse(headers.GetValueOrDefault("content-length", "0"));
                var body = new byte[len];
                await s.ReadExactlyAsync(body);
                headers.TryGetValue("authorization", out var auth);
                Authorizations.Add(auth);
                string resp;
                if (auth is not null && Check(auth))
                {
                    var bytes = Encoding.UTF8.GetBytes(ResponseBody);
                    resp = $"HTTP/1.1 200 OK\r\nContent-Type: application/soap+xml; charset=UTF-8\r\nContent-Length: {bytes.Length}\r\n\r\n{ResponseBody}";
                }
                else
                {
                    resp = $"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"{Realm}\", nonce=\"{Nonce}\", stale=\"false\", qop=\"auth\"\r\nContent-Length: 0\r\n\r\n";
                }
                await s.WriteAsync(Encoding.UTF8.GetBytes(resp));
            }
        }

        bool Check(string auth)
        {
            var p = DigestParams(auth);
            var want = Md5($"{Md5($"{User}:{Realm}:{Pass}")}:{Nonce}:{p["nc"]}:{p["cnonce"]}:auth:{Md5("POST:/wsman")}");
            return p["nonce"] == Nonce && p["uri"] == "/wsman" && p["response"] == want;
        }

        public void Dispose() => Listener.Stop();
    }

    static Target AmtTarget(int port) => new("z440", "127.0.0.1", port, TargetKind.Amt);

    [Test]
    public async Task WS_Man_は_401_の_challenge_を返し_Digest_を付ければ通す()
    {
        using var amt = new FakeAmtHttp();
        using var wsman = new AmtWsman();
        var body = "<Envelope>RequestPowerStateChange_INPUT<r:PowerState>8</r:PowerState></Envelope>"u8.ToArray();
        var first = await wsman.Send(AmtTarget(amt.Port), null, "application/soap+xml; charset=utf-8", body, CancellationToken.None);
        await Assert.That(first.Status).IsEqualTo(401);
        await Assert.That(first.Authenticate).IsEqualTo($"Digest realm=\"{Realm}\", nonce=\"{amt.Nonce}\", stale=\"false\", qop=\"auth\"");

        var auth = Authorization(amt.Nonce, Pass);
        var ok = await wsman.Send(AmtTarget(amt.Port), auth, "application/soap+xml; charset=utf-8", body, CancellationToken.None);
        await Assert.That(ok.Status).IsEqualTo(200);
        await Assert.That(Encoding.UTF8.GetString(ok.Body)).IsEqualTo("<Envelope>ok</Envelope>");
        await Assert.That(ok.ContentType).Contains("application/soap+xml");
        // Authorization は書き換えずに届く。行き先はいつも /wsman
        await Assert.That(amt.Authorizations[^1]).IsEqualTo(auth);
        await Assert.That(amt.Paths.All(p => p == "/wsman")).IsTrue();
        await Assert.That(Amt.PowerRequest(body)).IsEqualTo("8");
    }

    [Test]
    public async Task WS_Man_はパスワードが違えば_401_のまま()
    {
        using var amt = new FakeAmtHttp();
        using var wsman = new AmtWsman();
        var r = await wsman.Send(AmtTarget(amt.Port), Authorization(amt.Nonce, "wrong"), null, "<x/>"u8.ToArray(), CancellationToken.None);
        await Assert.That(r.Status).IsEqualTo(401);
        await Assert.That(r.Authenticate).IsNotNull();
    }

    [Test]
    public async Task WS_Man_の返事が大きすぎれば断る()
    {
        using var amt = new FakeAmtHttp { ResponseBody = new string('x', AmtWsman.MaxResponse + 1) };
        using var wsman = new AmtWsman();
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            wsman.Send(AmtTarget(amt.Port), Authorization(amt.Nonce, Pass), null, "<x/>"u8.ToArray(), CancellationToken.None));
    }

    [Test]
    public async Task WS_Man_は_RDP_の先には送らない()
    {
        using var wsman = new AmtWsman();
        await Assert.ThrowsAsync<ArgumentException>(() =>
            wsman.Send(new Target("pc", "127.0.0.1", 3389), null, null, [], CancellationToken.None));
    }

    [Test]
    public async Task 電源の操作でない本文はログに残さない()
    {
        await Assert.That(Amt.PowerRequest("<Enumerate/>"u8)).IsNull();
        await Assert.That(Amt.PowerRequest("<h:RequestPowerStateChange_INPUT><h:PowerState> 10 </h:PowerState>"u8)).IsEqualTo("10");
    }

    [Test]
    public async Task 証明書の指紋は書いたときだけ確かめる()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var cert = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=amt", key, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var fp = Convert.ToHexString(SHA256.HashData(cert.RawData));
        var t = new Target("a", "h", Target.AmtHttps, TargetKind.Amt, true);
        await Assert.That(Amt.CheckCert(t, cert)).IsTrue();
        await Assert.That(Amt.CheckCert(t with { CertSha256 = fp }, cert)).IsTrue();
        await Assert.That(Amt.CheckCert(t with { CertSha256 = new string('0', 64) }, cert)).IsFalse();
        await Assert.That(Amt.CheckCert(t with { CertSha256 = fp }, null)).IsFalse();
    }

    // ---- SOL(リダイレクト) ----

    /// <summary>試験用の口。RelayTests の FakeChannel と同じ形。閉じた理由を残す</summary>
    sealed class FakeChannel : IRelayChannel
    {
        readonly Channel<byte[]> _in = Channel.CreateUnbounded<byte[]>();
        public readonly Channel<byte[]> Sent = Channel.CreateUnbounded<byte[]>();
        public string? CloseReason;
        byte[]? _rest;

        public void Feed(byte[] b) => _in.Writer.TryWrite(b);
        public void End() => _in.Writer.TryComplete();

        public async ValueTask<int> ReceiveAsync(Memory<byte> buf, CancellationToken ct)
        {
            var b = _rest;
            _rest = null;
            if (b is null)
            {
                if (!await _in.Reader.WaitToReadAsync(ct)) return 0;
                b = await _in.Reader.ReadAsync(ct);
            }
            int n = Math.Min(b.Length, buf.Length);
            b.AsSpan(0, n).CopyTo(buf.Span);
            if (n < b.Length) _rest = b[n..];
            return n;
        }

        public ValueTask SendAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
        {
            Sent.Writer.TryWrite(data.ToArray());
            return ValueTask.CompletedTask;
        }

        public Task CloseAsync(string reason, CancellationToken ct)
        {
            CloseReason ??= reason;
            Sent.Writer.TryComplete();
            return Task.CompletedTask;
        }

        public async Task<byte[]> Take(int n)
        {
            var all = new List<byte>();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (all.Count < n) all.AddRange(await Sent.Reader.ReadAsync(cts.Token));
            return [.. all];
        }
    }

    /// <summary>偽の AMT のリダイレクトの口。届いたものを大文字にして返す(中身は見ない。手順はブラウザが話す)</summary>
    static async Task<string> FakeRedirect(TcpListener l)
    {
        using var c = await l.AcceptTcpClientAsync();
        var s = c.GetStream();
        var buf = new byte[4096];
        var seen = new StringBuilder();
        int n;
        while ((n = await s.ReadAsync(buf)) > 0)
        {
            seen.Append(Encoding.ASCII.GetString(buf, 0, n));
            for (int i = 0; i < n; i++) buf[i] = (byte)char.ToUpperInvariant((char)buf[i]);
            await s.WriteAsync(buf.AsMemory(0, n));
        }
        return seen.ToString();
    }

    static (TcpListener, Target) ListenRedirect()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        // 試験では port を変えられないので、RedirectPort の代わりに Port を使う先を作る
        return (l, new Target("z440", "127.0.0.1", ((IPEndPoint)l.LocalEndpoint).Port, TargetKind.Amt));
    }

    [Test]
    public async Task SOL_はトークンの行のあとを_AMT_にそのまま流す()
    {
        var (l, target) = ListenRedirect();
        var amt = FakeRedirect(l);
        var ch = new FakeChannel();
        string? seen = null;
        var relay = AmtRelay.Run(ch, tok => { seen = tok; return target; }, _ => { }, CancellationToken.None,
            redirectPort: _ => target.Port);
        // トークンの行が分かれて届き、同じかたまりに続きのバイトが付いてくる
        ch.Feed("tok"u8.ToArray());
        ch.Feed("en\n\x10sol"u8.ToArray());
        var back = await ch.Take(4);
        await Assert.That(seen).IsEqualTo("token");
        await Assert.That(Encoding.ASCII.GetString(back)).IsEqualTo("\x10SOL");
        ch.Feed("abc"u8.ToArray());
        await Assert.That(Encoding.ASCII.GetString(await ch.Take(3))).IsEqualTo("ABC");
        ch.End();
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        l.Stop();
        await Assert.That(await amt.WaitAsync(TimeSpan.FromSeconds(10))).IsEqualTo("\x10solabc");
    }

    [Test]
    public async Task SOL_は_RDP_の先や通らないトークンでは閉じる()
    {
        foreach (var t in new Target?[] { null, new Target("pc", "127.0.0.1", 3389) })
        {
            var ch = new FakeChannel();
            var logs = new List<string>();
            var relay = AmtRelay.Run(ch, _ => t, logs.Add, CancellationToken.None);
            ch.Feed("bad\n"u8.ToArray());
            await relay.WaitAsync(TimeSpan.FromSeconds(10));
            await Assert.That(ch.CloseReason).IsEqualTo("token rejected");
        }
    }

    [Test]
    public async Task SOL_はトークンが来なければ時間切れで閉じる()
    {
        var ch = new FakeChannel();
        var relay = AmtRelay.Run(ch, _ => throw new InvalidOperationException("呼ばれない"), _ => { }, CancellationToken.None, TimeSpan.FromMilliseconds(100));
        ch.Feed("tok"u8.ToArray());
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.CloseReason).IsEqualTo("token timeout");
    }

    [Test]
    public async Task SOL_は長すぎるトークンを断る()
    {
        var ch = new FakeChannel();
        var relay = AmtRelay.Run(ch, _ => throw new InvalidOperationException("呼ばれない"), _ => { }, CancellationToken.None);
        ch.Feed(new byte[5000]);
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.CloseReason).IsEqualTo("token too large");
    }

    [Test]
    public async Task SOL_は_AMT_に届かなければ理由を付けて閉じる()
    {
        var (l, target) = ListenRedirect();
        l.Stop();
        var ch = new FakeChannel();
        var relay = AmtRelay.Run(ch, _ => target, _ => { }, CancellationToken.None, redirectPort: _ => target.Port);
        ch.Feed("tok\n"u8.ToArray());
        await relay.WaitAsync(TimeSpan.FromSeconds(30));
        await Assert.That(ch.CloseReason).IsEqualTo("cannot reach AMT");
    }
}
