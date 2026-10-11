using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;

namespace Mado;

/// <summary>
/// WebSocket(ブラウザの IronRDP)と RDP サーバーのあいだの中継。
///
/// 1. 最初に RDCleanPath の要求を受け取る(複数のメッセージに分かれて来てもよい)
/// 2. RDP サーバーに TCP でつなぎ、要求に入っていた X.224 の接続要求を送り、接続確認を受け取る
/// 3. 同じソケットの上で TLS を張り、サーバーの証明書の連なりを取る
/// 4. RDCleanPath の応答(接続確認 + 証明書)を返し、あとは WebSocket ↔ TLS をそのまま流す
///
/// つなぐ先はトークン(proxy_auth)に入っている、設定の targets のどれか。ブラウザが送ってくる destination は見ない
/// (どこへでも行ける中継にしない)。RDP との TLS は SslStream(Windows では SChannel)で、RDP の自己署名証明書を
/// そのまま受けられる(bun 版のように鍵交換を絞る必要は無い)。
/// </summary>
internal static class Relay
{
    const int MaxRequest = 64 * 1024;

    /// <summary>authorize は proxy_auth(使い捨てのトークン)を確かめて、つなぐ先を返す。だめなら null</summary>
    public static async Task Run(WebSocket ws, Func<string?, Target?> authorize, Action<string> log, CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        var pending = new MemoryStream();
        (RdCleanPath.Request Request, ReadOnlyMemory<byte> Remaining)? parsed = null;
        while (parsed is null)
        {
            var r = await ws.ReceiveAsync(buf, ct);
            if (r.MessageType == WebSocketMessageType.Close) return;
            if (r.MessageType != WebSocketMessageType.Binary)
            {
                await ws.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "binary only", ct);
                return;
            }
            pending.Write(buf, 0, r.Count);
            // RDCleanPath の要求は 1 KB ほど。いつまでも揃わないものを溜め込まない
            if (pending.Length > MaxRequest)
            {
                await Fail(ws, 413, "RDCleanPath request too large", log, ct);
                return;
            }
            try { parsed = RdCleanPath.Parse(pending.ToArray()); }
            catch (FormatException e)
            {
                await Fail(ws, 400, $"bad RDCleanPath request: {e.Message}", log, ct);
                return;
            }
        }
        var (req, rest) = (parsed.Value.Request, parsed.Value.Remaining);
        if (req.Version != RdCleanPath.Version)
        {
            await Fail(ws, 400, $"unsupported RDCleanPath version {req.Version}", log, ct);
            return;
        }
        if (authorize(req.ProxyAuth) is not { } target)
        {
            await Fail(ws, 401, "proxy_auth rejected", log, ct);
            return;
        }
        if (req.X224 is null)
        {
            await Fail(ws, 400, "no X.224 connection request (VMConnect is not supported)", log, ct);
            return;
        }

        log($"relay to {target.Name} ({target.Host}:{target.Port})");
        using var tcp = new TcpClient();
        SslStream ssl;
        try
        {
            await tcp.ConnectAsync(target.Host, target.Port, ct);
            var net = tcp.GetStream();
            if (req.PreconnectionBlob is { } pcb) await net.WriteAsync(System.Text.Encoding.UTF8.GetBytes(pcb), ct);
            await net.WriteAsync(req.X224, ct);
            var cc = await ReadTpkt(net, ct);
            // RDP_NEG_FAILURE(0x03)なら TLS には進まず、そのまま返す(IronRDP が理由を出す)
            if (cc.Length >= 12 && cc[11] == 0x03)
            {
                await Send(ws, RdCleanPath.Error(RdCleanPath.NegotiationError, x224: cc), ct);
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "negotiation failure", ct);
                return;
            }
            var chain = new List<byte[]>();
            ssl = new SslStream(net, leaveInnerStreamOpen: false);
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = target.Host,
                // RDP の証明書は自己署名なので検証はしない。CredSSP がこの証明書の公開鍵に結びつけて認証する
                RemoteCertificateValidationCallback = (_, cert, ch, _) =>
                {
                    if (ch is not null)
                        foreach (var e in ch.ChainElements) chain.Add(e.Certificate.RawData);
                    if (chain.Count == 0 && cert is not null) chain.Add(cert.GetRawCertData());
                    return true;
                },
            }, ct);
            if (chain.Count == 0) throw new IOException("RDP server sent no certificate");
            await Send(ws, RdCleanPath.Response(cc, chain, $"{target.Host}:{target.Port}"), ct);
            log($"relay up: {ssl.SslProtocol} {ssl.NegotiatedCipherSuite}");
        }
        catch (Exception e) when (e is IOException or SocketException or System.Security.Authentication.AuthenticationException)
        {
            await Fail(ws, 502, e.Message, log, ct);
            return;
        }

        await using (ssl)
        {
            if (!rest.IsEmpty) await ssl.WriteAsync(rest, ct);
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var up = Pump(async () =>
            {
                while (true)
                {
                    var r = await ws.ReceiveAsync(buf, stop.Token);
                    if (r.MessageType == WebSocketMessageType.Close) return;
                    await ssl.WriteAsync(buf.AsMemory(0, r.Count), stop.Token);
                }
            });
            var down = Pump(async () =>
            {
                var b = new byte[64 * 1024];
                while (true)
                {
                    var n = await ssl.ReadAsync(b, stop.Token);
                    if (n == 0) return;
                    await ws.SendAsync(b.AsMemory(0, n), WebSocketMessageType.Binary, true, stop.Token);
                }
            });
            await Task.WhenAny(up, down);
            await stop.CancelAsync();
            await Task.WhenAll(up, down);
        }
        if (ws.State == WebSocketState.Open)
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
    }

    /// <summary>片方向の流し込み。相手が切れたら黙って終わる</summary>
    static async Task Pump(Func<Task> loop)
    {
        try { await loop(); }
        catch (Exception e) when (e is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException) { }
    }

    static Task Send(WebSocket ws, byte[] data, CancellationToken ct) =>
        ws.SendAsync(data.AsMemory(), WebSocketMessageType.Binary, true, ct).AsTask();

    static async Task Fail(WebSocket ws, ulong httpStatus, string msg, Action<string> log, CancellationToken ct)
    {
        log($"relay failed: {msg}");
        if (ws.State != WebSocketState.Open) return;
        await Send(ws, RdCleanPath.Error(RdCleanPath.GeneralError, httpStatus), ct);
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "relay failed", ct);
    }

    /// <summary>TPKT(RFC 1006)を 1 つ読む。ヘッダーの 3〜4 バイト目が全体の長さ</summary>
    internal static async Task<byte[]> ReadTpkt(Stream s, CancellationToken ct)
    {
        var head = new byte[4];
        await s.ReadExactlyAsync(head, ct);
        if (head[0] != 3) throw new IOException("RDP server did not answer with TPKT");
        var len = (head[2] << 8) | head[3];
        if (len < 4) throw new IOException("TPKT: bad length");
        var all = new byte[len];
        head.CopyTo(all, 0);
        await s.ReadExactlyAsync(all.AsMemory(4), ct);
        return all;
    }
}
