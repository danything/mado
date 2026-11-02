using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;

namespace Mado;

/// <summary>
/// Intel AMT の電源(WS-Man)と SOL(リダイレクト)の中継。
///
/// AMT の認証は HTTP Digest で、WS-Man もリダイレクトもブラウザが Digest の応答を計算する(web/amt/)。
/// mado は AMT のユーザー名もパスワードも受け取らない。Digest の Authorization は計算した結果だけで、そのまま AMT に渡す。
/// つなぐ先は設定の targets(type が amt)だけ。WS-Man は URL の名前で、SOL は /api/token のトークンで決まる。
/// </summary>
internal static partial class Amt
{
    /// <summary>AMT の TLS の証明書を確かめる。指紋(cert_sha256)を書いていればそれと比べ、無ければ確かめない(AMT の証明書は自己署名がふつう)</summary>
    public static bool CheckCert(Target t, X509Certificate? cert) =>
        t.CertSha256 is null
        || (cert is not null && CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(cert.GetRawCertData()), Convert.FromHexString(t.CertSha256)));

    /// <summary>URL に入れるホスト。IPv6 のアドレスは [] で包む</summary>
    public static string UriHost(string host) => host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;

    /// <summary>電源の操作(RequestPowerStateChange)なら、頼んだ PowerState を返す。ログに残すため</summary>
    public static string? PowerRequest(ReadOnlySpan<byte> body)
    {
        var s = Encoding.UTF8.GetString(body);
        if (!s.Contains("RequestPowerStateChange_INPUT", StringComparison.Ordinal)) return null;
        var m = PowerStateRe().Match(s);
        return m.Success ? m.Groups[1].Value : "?";
    }

    [GeneratedRegex(@"<(?:\w+:)?PowerState>\s*(\d+)\s*<")]
    private static partial Regex PowerStateRe();
}

/// <summary>AMT の WS-Man(/wsman)への中継の返事。Authenticate は AMT の WWW-Authenticate</summary>
internal sealed record WsmanResponse(int Status, string? Authenticate, string? ContentType, byte[] Body);

/// <summary>
/// WS-Man の SOAP を、決まった AMT の /wsman にだけ送る。本文は見ない(電源の操作をログに残すときだけ読む)。
/// Authorization はブラウザが計算した Digest をそのまま付け、AMT の WWW-Authenticate はそのまま返す。
/// </summary>
internal sealed class AmtWsman : IDisposable
{
    /// <summary>要求の本文の上限。電源の操作や列挙の SOAP は数 KB</summary>
    public const int MaxRequest = 64 * 1024;
    /// <summary>返事の本文の上限。列挙の結果でもふつうは数十 KB</summary>
    public const int MaxResponse = 4 * 1024 * 1024;
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    // つなぐ先ごとに口を分ける。TLS の証明書の確かめ方(指紋)が先ごとに違うため
    readonly Dictionary<string, HttpMessageInvoker> _clients = new(StringComparer.Ordinal);
    readonly Lock _gate = new();

    HttpMessageInvoker ClientFor(Target t)
    {
        lock (_gate)
        {
            if (_clients.TryGetValue(t.Name, out var c)) return c;
            var handler = new SocketsHttpHandler
            {
                UseProxy = false,
                UseCookies = false,
                AllowAutoRedirect = false,
                Credentials = null,
                ConnectTimeout = TimeSpan.FromSeconds(10),
                PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
                SslOptions = new SslClientAuthenticationOptions
                {
                    RemoteCertificateValidationCallback = (_, cert, _, _) => Amt.CheckCert(t, cert),
                },
            };
            c = new HttpMessageInvoker(handler, disposeHandler: true);
            _clients[t.Name] = c;
            return c;
        }
    }

    public async Task<WsmanResponse> Send(Target t, string? authorization, string? contentType, byte[] body, CancellationToken ct)
    {
        if (t.Kind != TargetKind.Amt) throw new ArgumentException("AMT の先ではない", nameof(t));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        var url = $"{(t.Tls ? "https" : "http")}://{Amt.UriHost(t.Host)}:{t.Port}/wsman";
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new ByteArrayContent(body) };
        req.Content.Headers.ContentType = MediaTypeHeaderValue.TryParse(contentType, out var type)
            ? type : new MediaTypeHeaderValue("application/soap+xml") { CharSet = "utf-8" };
        if (!string.IsNullOrEmpty(authorization)) req.Headers.TryAddWithoutValidation("Authorization", authorization);
        using var res = await ClientFor(t).SendAsync(req, timeout.Token);
        var auth = res.Headers.WwwAuthenticate.Count > 0 ? string.Join(", ", res.Headers.GetValues("WWW-Authenticate")) : null;
        if (res.Content.Headers.ContentLength > MaxResponse) throw new HttpRequestException("AMT の返事が大きすぎる");
        await using var s = await res.Content.ReadAsStreamAsync(timeout.Token);
        using var ms = new MemoryStream();
        var buf = new byte[16 * 1024];
        int n;
        while ((n = await s.ReadAsync(buf, timeout.Token)) > 0)
        {
            if (ms.Length + n > MaxResponse) throw new HttpRequestException("AMT の返事が大きすぎる");
            ms.Write(buf, 0, n);
        }
        return new WsmanResponse((int)res.StatusCode, auth, res.Content.Headers.ContentType?.ToString(), ms.ToArray());
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var c in _clients.Values) c.Dispose();
            _clients.Clear();
        }
    }
}

/// <summary>
/// SOL など AMT のリダイレクト(16994 / 16995)への中継。ブラウザは WebSocket(/ws/amt)で来る。
///
/// 1. 最初に /api/token のトークンを送り、改行(\n)で終える。トークンの中のつなぐ先(type が amt)だけにつなぐ
/// 2. AMT のリダイレクトの port に TCP でつなぐ(tls なら TLS も張る)
/// 3. あとはそのまま流す。リダイレクトのプロトコル(Digest の認証、SOL)はブラウザが話す(web/amt/redirect.ts)
///
/// 失敗したら WebSocket を理由つきで閉じる。理由は短い英語(WebSocket の理由は 123 バイトまで)
/// </summary>
internal static class AmtRelay
{
    public const string Path = "/ws/amt";
    const int MaxToken = 4096;
    /// <summary>AMT に TCP でつなぐまで(と TLS を張るまで)の時間</summary>
    public static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);

    public static async Task Serve(string user, IRelayChannel client, Func<string?, Target?> authorize,
        Action<string> log, Action<int> sessions, CancellationToken ct)
    {
        sessions(+1);
        log($"amt open: {user}");
        try
        {
            await Run(client, authorize, m => log($"{user}: {m}"), ct);
        }
        catch (Exception e) when (e is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException) { }
        catch (Exception e)
        {
            log($"{user}: amt relay error: {e.Message}");
        }
        finally
        {
            sessions(-1);
            log($"amt close: {user}");
        }
    }

    /// <summary>redirectPort は試験用。つなぐ port を変える(既定は Target.RedirectPort)</summary>
    public static async Task Run(IRelayChannel client, Func<string?, Target?> authorize, Action<string> log, CancellationToken ct,
        TimeSpan? requestTimeout = null, Func<Target, int>? redirectPort = null)
    {
        var buf = new byte[MaxToken + 1024];
        var have = 0;
        int newline;
        using (var wait = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            wait.CancelAfter(requestTimeout ?? Relay.RequestTimeout);
            while ((newline = Array.IndexOf(buf, (byte)'\n', 0, have)) < 0)
            {
                if (have > MaxToken)
                {
                    await Fail(client, "token too large", log);
                    return;
                }
                int n;
                try { n = await client.ReceiveAsync(buf.AsMemory(have), wait.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    await Fail(client, "token timeout", log);
                    return;
                }
                if (n == 0) return;
                have += n;
            }
        }
        var token = Encoding.UTF8.GetString(buf, 0, newline).Trim();
        var rest = buf.AsMemory(newline + 1, have - newline - 1);
        if (authorize(token) is not { Kind: TargetKind.Amt } target)
        {
            await Fail(client, "token rejected", log);
            return;
        }

        var port = redirectPort?.Invoke(target) ?? target.RedirectPort;
        log($"amt relay to {target.Name} ({target.Host}:{port})");
        // キー入力は小さなパケットになる。溜めずにすぐ送る
        using var tcp = new TcpClient { NoDelay = true };
        Stream remote;
        try
        {
            // 黙って落とされる先で、OS の再送が終わるまで待たない
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                connect.CancelAfter(ConnectTimeout);
                try { await tcp.ConnectAsync(target.Host, port, connect.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new IOException("connect timeout"); }
            }
            remote = tcp.GetStream();
            if (target.Tls)
            {
                var ssl = new SslStream(remote, leaveInnerStreamOpen: false);
                using var handshake = CancellationTokenSource.CreateLinkedTokenSource(ct);
                handshake.CancelAfter(ConnectTimeout);
                try
                {
                    await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                    {
                        TargetHost = target.Host,
                        RemoteCertificateValidationCallback = (_, cert, _, _) => Amt.CheckCert(target, cert),
                    }, handshake.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new IOException("TLS handshake timeout"); }
                remote = ssl;
            }
        }
        catch (Exception e) when (e is IOException or SocketException or System.Security.Authentication.AuthenticationException)
        {
            await Fail(client, e is System.Security.Authentication.AuthenticationException ? "AMT TLS failed" : "cannot reach AMT", log, e.Message);
            return;
        }

        await using (remote)
        {
            if (!rest.IsEmpty) await remote.WriteAsync(rest, ct);
            await Relay.Splice(client, remote, ct);
        }
        await client.CloseAsync("", CancellationToken.None);
    }

    static async Task Fail(IRelayChannel client, string reason, Action<string> log, string? detail = null)
    {
        log($"amt relay failed: {reason}{(detail is null ? "" : $" ({detail})")}");
        try { await client.CloseAsync(reason, CancellationToken.None); }
        catch (Exception e) when (e is IOException or WebSocketException or ObjectDisposedException or InvalidOperationException or OperationCanceledException) { }
    }
}
