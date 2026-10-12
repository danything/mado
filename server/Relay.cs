using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;

namespace Mado;

/// <summary>
/// ブラウザの RDP クライアントとつながった WebSocket(または WebTransport の stream)と、RDP サーバーのあいだを中継する。
///
/// 1. 最初に RDCleanPath の要求を受け取る。複数のメッセージに分かれて来てもよい
/// 2. RDP サーバーに TCP でつなぎ、要求に入っていた X.224 の接続要求を送り、接続確認を受け取る
/// 3. 同じソケットの上で TLS を張り、サーバーの証明書の連なりを取る
/// 4. 接続確認と証明書を RDCleanPath の応答で返す。あとは WebSocket と TLS のあいだをそのまま流す
///
/// ブラウザ側の口は IRelayChannel で包む。WebSocket はメッセージ、WebTransport はバイトの流れだが、
/// RDCleanPath の要求は DER で長さが分かるので、どちらも「届いた分を溜めて、揃ったら読む」で同じに扱える。
///
/// つなぐ先は、proxy_auth のトークンに入っている設定の targets のどれか。どこへでも行ける中継にはしたくないので、
/// ブラウザが送ってくる destination は見ない。RDP との TLS は SslStream で張る。Windows では SChannel になり、
/// RDP の自己署名証明書をそのまま受けられる。bun 版のように鍵交換を絞る必要は無い。
/// </summary>
internal static class Relay
{
    const int MaxRequest = 64 * 1024;
    /// <summary>つないでから RDCleanPath の要求が揃うまでの時間。ログインしていても、何も送らない口をいつまでも開けておかない</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    /// <summary>authorize は proxy_auth の使い捨てのトークンを確かめて、つなぐ先を返す。通らなければ null</summary>
    public static Task Run(WebSocket ws, Func<string?, Target?> authorize, Action<string> log, CancellationToken ct) =>
        Run(new WebSocketChannel(ws), authorize, log, ct);

    public static async Task Run(IRelayChannel ws, Func<string?, Target?> authorize, Action<string> log, CancellationToken ct, TimeSpan? requestTimeout = null)
    {
        var buf = new byte[64 * 1024];
        var pending = new MemoryStream();
        (RdCleanPath.Request Request, ReadOnlyMemory<byte> Remaining)? parsed = null;
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        wait.CancelAfter(requestTimeout ?? RequestTimeout);
        while (parsed is null)
        {
            int n;
            try { n = await ws.ReceiveAsync(buf, wait.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // WebSocket は受信を取り消すと壊れるので、誤りの PDU は送れないことがある(Fail は失敗を飲み込む)
                await Fail(ws, 408, "RDCleanPath request timeout", log, ct);
                return;
            }
            if (n == 0) return;
            pending.Write(buf, 0, n);
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
        // キーやマウスの入力は小さなパケットになる。Nagle で溜めると遅れるので、すぐ送る
        using var tcp = new TcpClient { NoDelay = true };
        SslStream ssl;
        try
        {
            await tcp.ConnectAsync(target.Host, target.Port, ct);
            var net = tcp.GetStream();
            if (req.PreconnectionBlob is { } pcb) await net.WriteAsync(System.Text.Encoding.UTF8.GetBytes(pcb), ct);
            await net.WriteAsync(req.X224, ct);
            var cc = await ReadTpkt(net, ct);
            // RDP_NEG_FAILURE (0x03) なら TLS には進まず、そのまま返す。理由はブラウザが表示する
            if (cc.Length >= 12 && cc[11] == 0x03)
            {
                await ws.SendAsync(RdCleanPath.Error(RdCleanPath.NegotiationError, x224: cc), ct);
                await ws.CloseAsync("negotiation failure", ct);
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
            await ws.SendAsync(RdCleanPath.Response(cc, chain, $"{target.Host}:{target.Port}"), ct);
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
                    if (r == 0) return;
                    await ssl.WriteAsync(buf.AsMemory(0, r), stop.Token);
                }
            });
            var down = Pump(async () =>
            {
                var b = new byte[64 * 1024];
                while (true)
                {
                    var n = await ssl.ReadAsync(b, stop.Token);
                    if (n == 0) return;
                    await ws.SendAsync(b.AsMemory(0, n), stop.Token);
                }
            });
            await Task.WhenAny(up, down);
            await stop.CancelAsync();
            await Task.WhenAll(up, down);
        }
        await ws.CloseAsync("", CancellationToken.None);
    }

    /// <summary>片方向の流し込み。相手が切れたら黙って終わる</summary>
    static async Task Pump(Func<Task> loop)
    {
        try { await loop(); }
        catch (Exception e) when (e is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException) { }
    }

    static async Task Fail(IRelayChannel ws, ulong httpStatus, string msg, Action<string> log, CancellationToken ct)
    {
        log($"relay failed: {msg}");
        try
        {
            await ws.SendAsync(RdCleanPath.Error(RdCleanPath.GeneralError, httpStatus), ct);
            await ws.CloseAsync("relay failed", ct);
        }
        catch (Exception e) when (e is IOException or WebSocketException or ObjectDisposedException or InvalidOperationException or OperationCanceledException) { }
    }

    /// <summary>TPKT (RFC 1006) を 1 つ読む。ヘッダーの 3〜4 バイト目が全体の長さ</summary>
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

/// <summary>ブラウザ側の口。メッセージの切れ目は意味を持たない</summary>
internal interface IRelayChannel
{
    /// <summary>届いたバイトを読む。0 は相手が閉じた</summary>
    ValueTask<int> ReceiveAsync(Memory<byte> buf, CancellationToken ct);
    ValueTask SendAsync(ReadOnlyMemory<byte> data, CancellationToken ct);
    /// <summary>こちらから閉じる。もう閉じていれば何もしない</summary>
    Task CloseAsync(string reason, CancellationToken ct);
}

/// <summary>WebSocket。バイナリのメッセージだけを受ける。テキストが来たら閉じて終わる</summary>
internal sealed class WebSocketChannel(WebSocket ws) : IRelayChannel
{
    public async ValueTask<int> ReceiveAsync(Memory<byte> buf, CancellationToken ct)
    {
        var r = await ws.ReceiveAsync(buf, ct);
        if (r.MessageType == WebSocketMessageType.Close) return 0;
        if (r.MessageType != WebSocketMessageType.Binary)
        {
            await ws.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "binary only", ct);
            return 0;
        }
        // 空のバイナリのメッセージは閉じた印と区別できないので、次を待つ
        return r.Count == 0 ? await ReceiveAsync(buf, ct) : r.Count;
    }

    public ValueTask SendAsync(ReadOnlyMemory<byte> data, CancellationToken ct) =>
        ws.SendAsync(data, WebSocketMessageType.Binary, true, ct);

    public Task CloseAsync(string reason, CancellationToken ct) =>
        ws.State == WebSocketState.Open ? ws.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, ct) : Task.CompletedTask;
}

/// <summary>バイトの流れ(WebTransport の双方向 stream)。閉じると送信側に FIN が付く</summary>
internal sealed class StreamChannel(Stream s) : IRelayChannel
{
    public ValueTask<int> ReceiveAsync(Memory<byte> buf, CancellationToken ct) => s.ReadAsync(buf, ct);
    public ValueTask SendAsync(ReadOnlyMemory<byte> data, CancellationToken ct) => s.WriteAsync(data, ct);

    public Task CloseAsync(string reason, CancellationToken ct) => s.DisposeAsync().AsTask();
}