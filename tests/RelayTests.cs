using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Channels;

namespace Mado.Tests;

/// <summary>
/// 中継をバイトの流れ(WebTransport の stream と同じ形)で動かす。RDCleanPath の要求を細かく分けて送り、
/// 手元の偽の RDP サーバー(X.224 の接続確認と TLS)とのあいだで、行きと帰りのバイトが通ることを見る
/// </summary>
public class RelayTests
{
    /// <summary>試験用の口。送られたものは Sent に溜まる。Feed で届いたことにする</summary>
    sealed class FakeChannel : IRelayChannel
    {
        readonly Channel<byte[]> _in = Channel.CreateUnbounded<byte[]>();
        public readonly Channel<byte[]> Sent = Channel.CreateUnbounded<byte[]>();
        public bool Closed;
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
            Closed = true;
            Sent.Writer.TryComplete();
            return Task.CompletedTask;
        }

        /// <summary>送られたものを n バイト集める</summary>
        public async Task<byte[]> Take(int n)
        {
            var all = new List<byte>();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (all.Count < n) all.AddRange(await Sent.Reader.ReadAsync(cts.Token));
            return [.. all];
        }

        /// <summary>DER の長さを見て、RDCleanPath の PDU を 1 つ集める</summary>
        public async Task<Der.Tlv> TakePdu()
        {
            var all = new List<byte>();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (true)
            {
                if (Der.Read(all.ToArray()) is { } t) return t;
                all.AddRange(await Sent.Reader.ReadAsync(cts.Token));
            }
        }
    }

    static byte[] Request(string token, byte[] x224) => Der.Write(Der.Sequence,
        Der.Write(Der.Context(0), Der.WriteInteger(RdCleanPath.Version)),
        Der.Write(Der.Context(2), Der.WriteUtf8("mado")),
        Der.Write(Der.Context(3), Der.WriteUtf8(token)),
        Der.Write(Der.Context(6), Der.WriteOctets(x224)));

    // X.224 の接続要求(中身は偽の RDP サーバーが長さしか見ない)
    static readonly byte[] X224Request = [0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x08, 0x00, 0x03, 0, 0, 0];

    /// <summary>接続確認。protocol は RDP_NEG_RSP(0x02)か RDP_NEG_FAILURE(0x03)</summary>
    static byte[] Confirm(byte type) => [0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, type, 0x00, 0x08, 0x00, 0x01, 0, 0, 0];

    static X509Certificate2 SelfSigned()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=rdp-test", key, HashAlgorithmName.SHA256);
        using var c = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(1));
        // Windows の SChannel は一時的な鍵を受けないので、PKCS#12 を通して読み直す
        return X509CertificateLoader.LoadPkcs12(c.Export(X509ContentType.Pkcs12), null);
    }

    /// <summary>偽の RDP サーバー。接続確認を返し、type が 0x02 なら TLS を張って、届いたものを大文字にして返す</summary>
    static async Task FakeRdp(TcpListener l, byte type, X509Certificate2 cert)
    {
        using var c = await l.AcceptTcpClientAsync();
        var s = c.GetStream();
        var tpkt = await Relay.ReadTpkt(s, CancellationToken.None);
        if (tpkt.Length != X224Request.Length) throw new InvalidDataException("X.224 の要求が違う");
        await s.WriteAsync(Confirm(type));
        if (type != 0x02) return;
        await using var ssl = new SslStream(s);
        await ssl.AuthenticateAsServerAsync(cert);
        var buf = new byte[4096];
        int n;
        while ((n = await ssl.ReadAsync(buf)) > 0)
        {
            for (int i = 0; i < n; i++) buf[i] = (byte)char.ToUpperInvariant((char)buf[i]);
            await ssl.WriteAsync(buf.AsMemory(0, n));
        }
    }

    static (TcpListener, Target) Listen()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        return (l, new Target("t", "127.0.0.1", ((IPEndPoint)l.LocalEndpoint).Port));
    }

    /// <summary>要求を 1 バイトずつ送る。後ろに RDP のバイトを続けて付けても、TLS の後に流れる</summary>
    [Test]
    public async Task 分かれて届いた要求でも中継して両方向に流す()
    {
        var (l, target) = Listen();
        using var cert = SelfSigned();
        var rdp = FakeRdp(l, 0x02, cert);
        var ch = new FakeChannel();
        string? seen = null;
        var relay = Relay.Run(ch, auth => { seen = auth; return target; }, _ => { }, CancellationToken.None);

        foreach (var b in Request("tok", X224Request)) ch.Feed([b]);
        var resp = await ch.TakePdu();
        await Assert.That(seen).IsEqualTo("tok");
        // 応答: [6] x224 と [7] 証明書の連なり
        var fields = Der.ReadAll(resp.Value);
        var x224 = fields.First(f => f.Tag == Der.Context(6));
        await Assert.That(Der.ReadOctets(Der.Read(x224.Value)!.Value).SequenceEqual(Confirm(0x02))).IsTrue();
        await Assert.That(fields.Any(f => f.Tag == Der.Context(7))).IsTrue();

        ch.Feed("hello, "u8.ToArray());
        ch.Feed("rdp"u8.ToArray());
        var back = await ch.Take(10);
        await Assert.That(System.Text.Encoding.ASCII.GetString(back)).IsEqualTo("HELLO, RDP");

        ch.End();
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.Closed).IsTrue();
        l.Stop();
        await rdp.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Test]
    public async Task 接続確認が失敗ならそのまま返して閉じる()
    {
        var (l, target) = Listen();
        using var cert = SelfSigned();
        var rdp = FakeRdp(l, 0x03, cert);
        var ch = new FakeChannel();
        var relay = Relay.Run(ch, _ => target, _ => { }, CancellationToken.None);
        var req = Request("tok", X224Request);
        ch.Feed(req[..5]);
        ch.Feed(req[5..]);
        var resp = await ch.TakePdu();
        var fields = Der.ReadAll(resp.Value);
        // [1] error と [6] x224
        await Assert.That(fields.Any(f => f.Tag == Der.Context(1))).IsTrue();
        var x224 = fields.First(f => f.Tag == Der.Context(6));
        await Assert.That(Der.ReadOctets(Der.Read(x224.Value)!.Value).SequenceEqual(Confirm(0x03))).IsTrue();
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.Closed).IsTrue();
        l.Stop();
        await rdp.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Test]
    public async Task 要求が来なければ時間切れで_408_を返して閉じる()
    {
        var ch = new FakeChannel();
        var logs = new List<string>();
        var relay = Relay.Run(ch, _ => throw new InvalidOperationException("呼ばれない"), logs.Add, CancellationToken.None, TimeSpan.FromMilliseconds(100));
        // 途中まで送って止まる
        ch.Feed(Request("tok", X224Request)[..5]);
        var resp = await ch.TakePdu();
        var error = Der.ReadAll(resp.Value).First(f => f.Tag == Der.Context(1));
        var status = Der.ReadAll(Der.Read(error.Value)!.Value.Value).First(f => f.Tag == Der.Context(1));
        await Assert.That(Der.ReadInteger(Der.Read(status.Value)!.Value)).IsEqualTo(408UL);
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.Closed).IsTrue();
        await Assert.That(logs.Any(l => l.Contains("timeout"))).IsTrue();
    }

    [Test]
    public async Task Serve_は数を戻して開け閉めをログに残す()
    {
        var ch = new FakeChannel();
        var logs = new List<string>();
        var count = 0;
        var relay = Relay.Serve("wt", "u", ch, _ => null, logs.Add, d => count += d, CancellationToken.None);
        ch.Feed(Request("bad", X224Request));
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(count).IsEqualTo(0);
        await Assert.That(logs.First()).IsEqualTo("wt open: u");
        await Assert.That(logs.Last()).IsEqualTo("wt close: u");
        await Assert.That(logs.Any(l => l.StartsWith("u: relay failed: proxy_auth"))).IsTrue();
    }

    [Test]
    public async Task トークンが通らなければ_401_で閉じる()
    {
        var ch = new FakeChannel();
        var relay = Relay.Run(ch, _ => null, _ => { }, CancellationToken.None);
        ch.Feed(Request("bad", X224Request));
        var resp = await ch.TakePdu();
        // [1] error ::= SEQUENCE { [0] error_code, [1] http_status_code }
        var error = Der.ReadAll(resp.Value).First(f => f.Tag == Der.Context(1));
        var status = Der.ReadAll(Der.Read(error.Value)!.Value.Value).First(f => f.Tag == Der.Context(1));
        await Assert.That(Der.ReadInteger(Der.Read(status.Value)!.Value)).IsEqualTo(401UL);
        await relay.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(ch.Closed).IsTrue();
    }
}
