using System.Text;
using Mado.Quic;

namespace Mado.Tests;

/// <summary>WebTransport(HTTP/3)の部品。msquic が無くても動くところだけを試す</summary>
public class QuicTests
{
    [Test]
    [Arguments(0UL, "00")]
    [Arguments(37UL, "25")]
    [Arguments(15293UL, "7bbd")]
    [Arguments(494878333UL, "9d7f3e7d")]
    [Arguments(151288809941952652UL, "c2197c5eff14e88c")]
    public async Task 可変長整数は_RFC_9000_の例のとおり(ulong value, string hex)
    {
        var buf = new byte[8];
        int n = VarInt.Write(buf, value);
        await Assert.That(Convert.ToHexStringLower(buf, 0, n)).IsEqualTo(hex);
        await Assert.That(VarInt.TryRead(Convert.FromHexString(hex), out var back, out var len)).IsTrue();
        await Assert.That(back).IsEqualTo(value);
        await Assert.That(len).IsEqualTo(n);
        // 1 バイト足りなければ読めない
        await Assert.That(VarInt.TryRead(Convert.FromHexString(hex).AsSpan(0, n - 1), out _, out _)).IsFalse();
    }

    [Test]
    public async Task Huffman_は_RFC_7541_の例を読む()
    {
        var b = Huffman.Decode(Convert.FromHexString("f1e3c2e5f23a6ba0ab90f4ff"));
        await Assert.That(Encoding.ASCII.GetString(b)).IsEqualTo("www.example.com");
        b = Huffman.Decode(Convert.FromHexString("a8eb10649cbf"));
        await Assert.That(Encoding.ASCII.GetString(b)).IsEqualTo("no-cache");
    }

    [Test]
    public async Task Huffman_は全部のバイトを往復できる()
    {
        var all = Enumerable.Range(0, 256).Select(i => (byte)i).ToArray();
        await Assert.That(Huffman.Decode(Huffman.Encode(all)).SequenceEqual(all)).IsTrue();
    }

    [Test]
    [Arguments("00")]       // 詰め物が 1 でない
    [Arguments("ffffffff")] // EOS(30 bit の 1)が入っている
    public async Task Huffman_の不正な詰め物は誤り(string hex)
    {
        Assert.Throws<QpackException>(() => Huffman.Decode(Convert.FromHexString(hex)));
        await Task.CompletedTask;
    }

    /// <summary>Chrome が送る形の CONNECT。名前は Huffman の literal、:authority は静的表の名前と Huffman の値</summary>
    static byte[] ChromeConnect()
    {
        var w = new ByteWriter();
        w.Byte(0).Byte(0);
        Qpack.WriteInt(w, 0xc0, 6, 15); // :method CONNECT
        Qpack.WriteInt(w, 0xc0, 6, 23); // :scheme https
        var auth = Huffman.Encode("mado.example.com"u8);
        Qpack.WriteInt(w, 0x50, 4, 0); // :authority
        Qpack.WriteInt(w, 0x80, 7, (ulong)auth.Length);
        w.Bytes(auth);
        Qpack.WriteInt(w, 0x50, 4, 1); // :path
        Qpack.WriteInt(w, 0x00, 7, 3);
        w.Bytes("/wt"u8);
        var name = Huffman.Encode(":protocol"u8);
        Qpack.WriteInt(w, 0x28, 3, (ulong)name.Length);
        w.Bytes(name);
        var value = Huffman.Encode("webtransport"u8);
        Qpack.WriteInt(w, 0x80, 7, (ulong)value.Length);
        w.Bytes(value);
        Qpack.WriteInt(w, 0x50, 4, 90); // origin
        Qpack.WriteInt(w, 0x00, 7, 24);
        w.Bytes("https://mado.example.com"u8);
        return w.ToArray();
    }

    [Test]
    public async Task QPACK_で_CONNECT_を読む()
    {
        var headers = Qpack.Decode(ChromeConnect());
        await Assert.That(ConnectRequest.Parse(headers, out var req)).IsEqualTo(200);
        await Assert.That(req).IsEqualTo(new ConnectRequest("mado.example.com", "/wt", "https://mado.example.com"));
    }

    [Test]
    public async Task QPACK_は動的表の参照を断る()
    {
        // Required Insert Count が 0 でない
        Assert.Throws<QpackException>(() => Qpack.Decode([0x01, 0x00, 0xd1]));
        // 動的表の行(1T の T が 0)
        Assert.Throws<QpackException>(() => Qpack.Decode([0x00, 0x00, 0x80]));
        // 静的表に無い番号
        Assert.Throws<QpackException>(() => Qpack.Decode([0x00, 0x00, 0xff, 0x30]));
        await Task.CompletedTask;
    }

    [Test]
    public async Task QPACK_の書き出しは読み戻せる()
    {
        (string, string)[] fields = [(":status", "200"), (":status", "418"), ("sec-webtransport-http3-draft", "draft02")];
        var block = Qpack.Encode(fields);
        // :status 200 は静的表の 25 番
        await Assert.That(block[2]).IsEqualTo((byte)0xd9);
        await Assert.That(Qpack.Decode(block).SequenceEqual(fields)).IsTrue();
    }

    [Test]
    [Arguments(":method", "GET", 404)]
    [Arguments(":protocol", "connect-udp", 400)]
    [Arguments(":scheme", "http", 400)]
    [Arguments(":path", "wt", 400)]
    public async Task WebTransport_でない_CONNECT_は断る(string name, string value, int status)
    {
        var headers = Qpack.Decode(ChromeConnect()).Select(h => h.Name == name ? (h.Name, value) : h).ToList();
        await Assert.That(ConnectRequest.Parse(headers, out _)).IsEqualTo(status);
    }

    [Test]
    public async Task 疑似ヘッダーが重なれば断る()
    {
        var headers = Qpack.Decode(ChromeConnect());
        headers.Add((":path", "/other"));
        await Assert.That(ConnectRequest.Parse(headers, out _)).IsEqualTo(400);
    }

    [Test]
    [Arguments("https://mado.example.com", "/wt?token=ok", 200)]
    [Arguments("https://mado.example.com", "/wt?x=1&token=ok", 200)]
    [Arguments("https://mado.example.com", "/wt", 401)]
    [Arguments("https://mado.example.com", "/wt?token=bad", 401)]
    [Arguments("https://mado.example.com", "/wt?token=", 401)]
    [Arguments("https://evil.example.com", "/wt?token=ok", 403)]
    [Arguments("null", "/wt?token=ok", 403)]
    [Arguments("", "/wt?token=ok", 403)]
    [Arguments("https://mado.example.com", "/ws?token=ok", 404)]
    [Arguments("https://mado.example.com", "/wt/x?token=ok", 404)]
    public async Task 中継は_origin_とパスとトークンを確かめる(string requestOrigin, string path, int status)
    {
        var target = new Target("t", "127.0.0.1", 3389);
        var got = WebTransportRelay.Check("https://mado.example.com", requestOrigin, path, t => t == "ok" ? (target, "u") : null, out var claim);
        await Assert.That(got).IsEqualTo(status);
        await Assert.That(claim is not null).IsEqualTo(status == 200);
    }

    static (RelayTokens Tokens, Func<string, (Target, string)?> Consume) Tokens()
    {
        var tokens = new RelayTokens(new Signer(new byte[32]), 60);
        var target = new Target("t", "127.0.0.1", 3389);
        return (tokens, t => tokens.Consume(t, null) is { } r ? (target, r.Name ?? r.Sub) : null);
    }

    [Test]
    public async Task 同じトークンで_2_度目の_CONNECT_は_401()
    {
        var (tokens, consume) = Tokens();
        var token = tokens.Issue(new RelayToken("u1", "t", "jti-1", "名前"));
        var path = $"/wt?token={Uri.EscapeDataString(token)}";
        await Assert.That(WebTransportRelay.Check("https://m", "https://m", path, consume, out var claim)).IsEqualTo(200);
        await Assert.That(claim!.User).IsEqualTo("名前");
        await Assert.That(WebTransportRelay.Check("https://m", "https://m", path, consume, out _)).IsEqualTo(401);
        // /ws でも、もう使えない
        await Assert.That(tokens.Consume(token, "u1")).IsNull();
    }

    [Test]
    public async Task RDCleanPath_のトークンは_CONNECT_のものと同じ文字列だけ通す()
    {
        var (tokens, consume) = Tokens();
        var token = tokens.Issue(new RelayToken("u1", "t", "jti-2"));
        var other = tokens.Issue(new RelayToken("u1", "t", "jti-3"));
        WebTransportRelay.Check("https://m", "https://m", $"/wt?token={token}", consume, out var claim);
        await Assert.That(WebTransportRelay.Authorize(claim!, token)).IsEqualTo(claim!.Target);
        // 2 度目でも通る(トークンは CONNECT で使ってあり、ここでは使わない)
        await Assert.That(WebTransportRelay.Authorize(claim, token)).IsNotNull();
        await Assert.That(WebTransportRelay.Authorize(claim, other)).IsNull();
        await Assert.That(WebTransportRelay.Authorize(claim, null)).IsNull();
    }

    [Test]
    public async Task 接続の数の上限()
    {
        var limits = new ConnectionLimits(maxTotal: 5, maxPreAuth: 3, maxPreAuthPerIp: 2);
        var a = System.Net.IPAddress.Parse("192.0.2.1");
        var b = System.Net.IPAddress.Parse("192.0.2.2");
        var c = System.Net.IPAddress.Parse("192.0.2.3");
        var a1 = limits.TryAdmit(a);
        var a2 = limits.TryAdmit(a);
        // 同じ IP からの、確かめる前の接続は 2 つまで
        await Assert.That(limits.TryAdmit(a)).IsNull();
        var b1 = limits.TryAdmit(b);
        // 確かめる前の接続は全体で 3 つまで
        await Assert.That(limits.TryAdmit(c)).IsNull();
        // 確かめたら数えなくなる。何度呼んでも 1 度だけ
        a1!.Authenticated();
        a1.Authenticated();
        await Assert.That(limits.PreAuth).IsEqualTo(2);
        var a3 = limits.TryAdmit(a);
        await Assert.That(a3).IsNotNull();
        a2!.Authenticated();
        b1!.Authenticated();
        a3!.Authenticated();
        var c1 = limits.TryAdmit(c);
        // 全体で 5 つまで
        await Assert.That(limits.Total).IsEqualTo(5);
        await Assert.That(limits.TryAdmit(c)).IsNull();
        // 終われば空く。Release も何度呼んでも 1 度だけ
        c1!.Release();
        c1.Release();
        a1.Release();
        await Assert.That(limits.Total).IsEqualTo(3);
        await Assert.That(limits.PreAuth).IsEqualTo(0);
        await Assert.That(limits.TryAdmit(c)).IsNotNull();
    }

    [Test]
    public async Task トークンは問い合わせ部分から読む()
    {
        await Assert.That(WebTransportRelay.TokenOf("/wt?token=a.b%2Dc")).IsEqualTo("a.b-c");
        await Assert.That(WebTransportRelay.TokenOf("/wt?a=1&token=x&b=2")).IsEqualTo("x");
        await Assert.That(WebTransportRelay.TokenOf("/wt")).IsNull();
    }

    [Test]
    public async Task SETTINGS_を組んで読む()
    {
        var frame = H3.Settings([(H3.SettingEnableConnectProtocol, 1), (H3.SettingWebTransportMaxSessionsDraft07, 1), (0x21, 7)]);
        await Assert.That(H3.TryReadFrame(frame, 1024, out var type, out var hl, out var pl, out var big)).IsTrue();
        await Assert.That(type).IsEqualTo(H3.FrameSettings);
        await Assert.That(big).IsFalse();
        var s = H3.ParseSettings(frame.AsSpan(hl, pl));
        await Assert.That(s![H3.SettingEnableConnectProtocol]).IsEqualTo(1UL);
        await Assert.That(s[H3.SettingWebTransportMaxSessionsDraft07]).IsEqualTo(1UL);
        await Assert.That(H3.IsGrease(0x21)).IsTrue();
        // 同じ識別子が 2 つは誤り
        await Assert.That(H3.ParseSettings([0x01, 0x00, 0x01, 0x00])).IsNull();
    }

    [Test]
    public async Task フレームは揃うまで読まない()
    {
        var frame = H3.Frame(H3.FrameData, new byte[100]);
        for (int i = 0; i < frame.Length; i++)
            await Assert.That(H3.TryReadFrame(frame.AsSpan(0, i), 1024, out _, out _, out _, out _)).IsFalse();
        await Assert.That(H3.TryReadFrame(frame, 1024, out _, out _, out var pl, out _)).IsTrue();
        await Assert.That(pl).IsEqualTo(100);
        // 大きすぎるフレームは中身を待たずに分かる
        H3.TryReadFrame(frame.AsSpan(0, 3), 50, out _, out _, out _, out var big);
        await Assert.That(big).IsTrue();
    }

    [Test]
    public async Task 受信の溜め置きは切り出しても順を保つ()
    {
        var b = new RecvBuffer();
        var all = new List<byte>();
        for (int i = 0; i < 1000; i++)
        {
            var chunk = Enumerable.Range(i, i % 7 + 1).Select(x => (byte)x).ToArray();
            b.Append(chunk);
            all.AddRange(chunk);
            if (i % 3 == 0)
            {
                int n = Math.Min(b.Count, 5);
                await Assert.That(b.Data[..n].ToArray().SequenceEqual(all.Take(n))).IsTrue();
                all.RemoveRange(0, n);
                b.Consume(n);
            }
        }
        await Assert.That(b.Data.ToArray().SequenceEqual(all)).IsTrue();
    }
}
