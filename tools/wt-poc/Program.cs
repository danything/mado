// WebTransport(HTTP/3)サーバーの試作。msquic を直接呼ぶ。
// 使い方: wt-poc [--port 4433] [--http 8080] [--cubic]
// - UDP の --port で WebTransport を待つ。パスは /wt
// - TCP の --http で試験用のページ(test.html)と証明書のハッシュ(/hash)を返す
// 証明書は起動のたびに作る。Chrome は自己署名の証明書を serverCertificateHashes でだけ受け入れる。
// その条件は ECDSA P-256 で、有効期間が 14 日以内であること。
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Mado.WebTransport;

internal static class Program
{
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly Lock LogLock = new();

    public static void Log(string s)
    {
        lock (LogLock) Console.WriteLine($"{Clock.Elapsed.TotalSeconds,9:F3} {s}");
    }

    static unsafe int Main(string[] args)
    {
        ushort port = 4433;
        int httpPort = 8080;
        bool cubic = false;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--port": port = ushort.Parse(args[++i]); break;
                case "--http": httpPort = int.Parse(args[++i]); break;
                case "--cubic": cubic = true; break;
                case "--selftest": return SelfTest();
                default: Console.Error.WriteLine($"知らない引数: {args[i]}"); return 2;
            }
        }

        // 証明書
        const string password = "mado-wt-poc";
        var (pfx, hash) = CreateCertificate(password);
        string hex = Convert.ToHexStringLower(hash);
        Log($"証明書の SHA-256: {hex}");
        Log($"JS: [{string.Join(",", hash)}]");

        // msquic
        MsQuic.Open();
        Log($"msquic {MsQuic.Version()} ({RuntimeInformation.OSDescription})");

        var settings = new QuicSettings();
        Set(ref settings, QuicSettings.IsSetIdleTimeoutMs); settings.IdleTimeoutMs = 30_000;
        Set(ref settings, QuicSettings.IsSetPeerBidiStreamCount); settings.PeerBidiStreamCount = 100;
        // 相手の単方向: 制御、QPACK の 2 本、WebTransport の単方向
        Set(ref settings, QuicSettings.IsSetPeerUnidiStreamCount); settings.PeerUnidiStreamCount = 16;
        Set(ref settings, QuicSettings.IsSetDatagramReceiveEnabled); settings.Bits |= QuicSettings.BitDatagramReceive;
        Set(ref settings, QuicSettings.IsSetCongestionControlAlgorithm);
        settings.CongestionControlAlgorithm = cubic ? MsQuic.CongestionCubic : MsQuic.CongestionBbr;

        using var config = new QuicServerConfig("mado-wt-poc", "h3", settings, pfx, password);
        var back = config.ReadBack();
        Log($"設定: 輻輳制御={(back.CongestionControlAlgorithm == MsQuic.CongestionBbr ? "BBR" : back.CongestionControlAlgorithm == 0 ? "CUBIC" : back.CongestionControlAlgorithm.ToString())} " +
            $"datagram受信={(back.Bits & QuicSettings.BitDatagramReceive) != 0} 双方向={back.PeerBidiStreamCount} 単方向={back.PeerUnidiStreamCount}");

        var handler = new EchoHandler();
        int seq = 0;
        var connections = new System.Collections.Concurrent.ConcurrentDictionary<int, Http3Connection>();
        using var listener = new QuicListener(config, conn =>
        {
            int id = Interlocked.Increment(ref seq);
            var h3 = new Http3Connection(conn, handler, $"c{id}");
            // 接続が終わるまで参照を持つ(GC に消されないように)
            connections[id] = h3;
            var prev = conn.OnClosed;
            conn.OnClosed = c => { prev?.Invoke(c); connections.TryRemove(id, out _); };
            return true;
        });
        listener.Start("h3", port);
        Log($"WebTransport: https://127.0.0.1:{port}/wt (UDP)");

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; cts.Cancel(); });

        var http = httpPort > 0 ? Task.Run(() => ServePage(httpPort, port, hex, cts.Token)) : Task.CompletedTask;
        if (httpPort > 0) Log($"試験のページ: http://localhost:{httpPort}/");

        try { Task.Delay(Timeout.Infinite, cts.Token).Wait(); }
        catch (AggregateException) { }
        Log("止める");
        MsQuic.Api->RegistrationShutdown(config.Registration, 0, 0);
        return 0;
    }

    static void Set(ref QuicSettings s, int bit) => s.IsSetFlags |= 1UL << bit;

    /// <summary>QPACK と Huffman の確かめ。RFC 7541 C.4.1 の例と、往復。</summary>
    static int SelfTest()
    {
        int bad = 0;
        void Expect(bool ok, string what) { Console.WriteLine($"{(ok ? "ok  " : "NG  ")}{what}"); if (!ok) bad++; }

        var www = Huffman.Decode(Convert.FromHexString("f1e3c2e5f23a6ba0ab90f4ff"));
        Expect(Encoding.ASCII.GetString(www) == "www.example.com", "Huffman: RFC 7541 C.4.1");
        var all = new byte[256];
        for (int i = 0; i < 256; i++) all[i] = (byte)i;
        Expect(Huffman.Decode(Huffman.Encode(all)).AsSpan().SequenceEqual(all), "Huffman: 0-255 の往復");
        bool threw = false;
        try { Huffman.Decode([0x00]); } catch (QpackException) { threw = true; }
        Expect(threw, "Huffman: 0 の詰め物は誤り");

        (string, string)[] fields = [(":method", "CONNECT"), (":protocol", "webtransport"), (":path", "/wt"), ("origin", "http://localhost:8080"), (":status", "200")];
        var dec = Qpack.Decode(Qpack.Encode(fields));
        Expect(dec.SequenceEqual(fields), "QPACK: 往復");

        // 名前を Huffman で書いた literal(001N H)と、値を Huffman で書いた名前参照(01NT)
        var w = new ByteWriter();
        w.Byte(0).Byte(0);
        var name = Huffman.Encode(Encoding.ASCII.GetBytes("sec-webtransport-http3-draft02"));
        Qpack.WriteInt(w, 0x28, 3, (ulong)name.Length); w.Bytes(name);
        var one = Huffman.Encode("1"u8);
        Qpack.WriteInt(w, 0x80, 7, (ulong)one.Length); w.Bytes(one);
        var host = Huffman.Encode("localhost:4433"u8);
        Qpack.WriteInt(w, 0x50, 4, 0); // :authority
        Qpack.WriteInt(w, 0x80, 7, (ulong)host.Length); w.Bytes(host);
        dec = Qpack.Decode(w.Span);
        Expect(dec.SequenceEqual([("sec-webtransport-http3-draft02", "1"), (":authority", "localhost:4433")]), "QPACK: Huffman の literal");

        Expect(VarInt.Size(VarInt.Max) == 8 && VarInt.TryRead([0xc2, 0x19, 0x7c, 0x5e, 0xff, 0x14, 0xe8, 0x8c], out var v, out _) && v == 151288809941952652, "varint: RFC 9000 A.1");
        Console.WriteLine(bad == 0 ? "すべて通った" : $"{bad} 件が失敗");
        return bad == 0 ? 0 : 1;
    }

    /// <summary>ECDSA P-256 の自己署名の証明書。有効期間は 13 日。PKCS#12 と DER の SHA-256 を返す。</summary>
    static (byte[] Pfx, byte[] Hash) CreateCertificate(string password)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=mado-wt-poc", key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddIpAddress(IPAddress.Loopback);
        san.AddIpAddress(IPAddress.IPv6Loopback);
        req.CertificateExtensions.Add(san.Build());
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, false));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        var now = DateTimeOffset.UtcNow;
        using var cert = req.CreateSelfSigned(now.AddMinutes(-5), now.AddDays(13));
        var pfx = cert.ExportPkcs12(Pkcs12ExportPbeParameters.Pbes2Aes256Sha256, password);
        return (pfx, SHA256.HashData(cert.RawData));
    }

    /// <summary>試験のページを返す小さな HTTP/1.1。/ は test.html、/hash は証明書のハッシュ。</summary>
    static async Task ServePage(int httpPort, ushort wtPort, string hex, CancellationToken ct)
    {
        var l = new TcpListener(IPAddress.IPv6Any, httpPort);
        l.Server.DualMode = true;
        l.Start();
        ct.Register(l.Stop);
        while (!ct.IsCancellationRequested)
        {
            TcpClient c;
            try { c = await l.AcceptTcpClientAsync(ct); }
            catch { break; }
            _ = Task.Run(async () =>
            {
                using (c)
                {
                    try
                    {
                        var s = c.GetStream();
                        var buf = new byte[4096];
                        int n = await s.ReadAsync(buf, ct);
                        var line = Encoding.ASCII.GetString(buf, 0, n).Split("\r\n")[0];
                        var path = line.Split(' ').ElementAtOrDefault(1) ?? "/";
                        byte[] body;
                        string type;
                        int status = 200;
                        if (path.StartsWith("/hash"))
                        {
                            body = Encoding.ASCII.GetBytes(hex);
                            type = "text/plain";
                        }
                        else if (path == "/" || path.StartsWith("/?") || path.StartsWith("/test.html"))
                        {
                            body = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "test.html"));
                            type = "text/html; charset=utf-8";
                        }
                        else
                        {
                            body = Encoding.ASCII.GetBytes("not found");
                            type = "text/plain";
                            status = 404;
                        }
                        var head = $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Not Found")}\r\nContent-Type: {type}\r\nContent-Length: {body.Length}\r\n" +
                                   "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
                        await s.WriteAsync(Encoding.ASCII.GetBytes(head), ct);
                        await s.WriteAsync(body, ct);
                    }
                    catch (Exception e) when (e is IOException or OperationCanceledException or SocketException) { }
                }
            }, ct);
        }
    }
}
