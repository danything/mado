using Mado.Quic;

namespace Mado;

/// <summary>
/// WebTransport で来たブラウザを RDP へ中継する。/ws と同じ Relay を、最初の双方向 stream の上で動かす。
///
/// 認証は /ws と同じ強さにする。WebTransport の CONNECT には Cookie が付かないので、ログインの確かめ方だけが違う。
/// - Origin が mado 自身(https://host)であること。CONNECT の Origin はブラウザが付け、ページからは変えられない
/// - CONNECT の /wt?token=... に、/api/token の出した使い捨てのトークンがあること。ここでトークンを使う(2 度目の CONNECT は 401)。
///   /ws が Cookie で断るのと同じく、ログインしていない相手には中継の入口(RDCleanPath を読むところ)を見せない
/// - RDCleanPath の proxy_auth が、CONNECT で使ったトークンと同じ文字列であること。ここではもう使わない
/// トークンは署名付きで、60 秒で切れ、1 度しか使えず、つなぐ先が決まっている。/api/token はログインの Cookie で守られ、
/// CORS でほかのサイトからは中身を読めない。だからトークンを持っているのは、ログインしたページだけ。
/// /ws ではさらにトークンの sub と Cookie の sub が同じことを見るが、トークンを手に入れられるのは Cookie を持つページだけなので、
/// 確かめる相手が増えるだけで、守りの強さは変わらない。
/// トークンは CONNECT の URL に入るが、mado はパスをログに書かない。
///
/// 放っておかれた接続が残らないように、CONNECT の後 RequestTimeout のうちに中継の stream が開いて RDCleanPath の要求が
/// 届かなければ閉じる(stream が開いた後は Relay.Run が同じ時間で見る)
/// </summary>
internal sealed class WebTransportRelay(
    string origin,
    Func<string, (Target Target, string User)?> consume,
    Action<string> log,
    Action<int> sessions,
    CancellationToken stopping) : IWebTransportHandler
{
    public const string Path = "/wt";

    /// <summary>CONNECT で使ったトークンと、それで決まったつなぐ先。セッションの State に置く</summary>
    internal sealed class Claim(string token, Target target, string user)
    {
        public string Token { get; } = token;
        public Target Target { get; } = target;
        public string User { get; } = user;
        public bool Started;
        public Timer? Wait;
        public CancellationTokenSource? Cts;
    }

    public int Accept(WebTransportSession session)
    {
        int status = Check(origin, session.Origin, session.Path, consume, out var claim);
        if (claim is null) return status;
        session.State = claim;
        // 中継の stream が来なければ閉じる
        claim.Wait = new Timer(_ =>
        {
            if (Volatile.Read(ref claim.Started)) return;
            log($"{claim.User}: wt: 中継の stream が来ないので閉じる");
            session.Close(0, "timeout");
        }, null, Relay.RequestTimeout, Timeout.InfiniteTimeSpan);
        return 200;
    }

    /// <summary>
    /// CONNECT を受けるか。Origin が違えば 403、パスが /wt でなければ 404、トークンが使えなければ 401。
    /// 受けるときはトークンを使い、claim を返す
    /// </summary>
    internal static int Check(string origin, string requestOrigin, string path, Func<string, (Target Target, string User)?> consume, out Claim? claim)
    {
        claim = null;
        if (requestOrigin != origin) return 403;
        var q = path.IndexOf('?');
        if ((q < 0 ? path : path[..q]) != Path) return 404;
        if (TokenOf(path) is not { } t || consume(t) is not { } c) return 401;
        claim = new Claim(t, c.Target, c.User);
        return 200;
    }

    /// <summary>パスの問い合わせ部分の token</summary>
    internal static string? TokenOf(string path)
    {
        var q = path.IndexOf('?');
        if (q < 0) return null;
        foreach (var part in path[(q + 1)..].Split('&'))
            if (part.StartsWith("token=", StringComparison.Ordinal)) return Uri.UnescapeDataString(part[6..]);
        return null;
    }

    /// <summary>RDCleanPath の proxy_auth が CONNECT のトークンと同じなら、つなぐ先を返す。トークンはもう使ってある</summary>
    internal static Target? Authorize(Claim claim, string? auth) => auth == claim.Token ? claim.Target : null;

    public void OnBidiStream(WebTransportSession session, WebTransportStream stream)
    {
        // 中継は 1 セッションに 1 本だけ。2 本目からは打ち切る
        if (session.State is not Claim claim || claim.Started)
        {
            stream.Abort(H3.RequestRejected);
            return;
        }
        Volatile.Write(ref claim.Started, true);
        claim.Wait?.Dispose();
        var cts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        claim.Cts = cts;
        var bytes = new WebTransportByteStream(stream);
        _ = Task.Run(async () =>
        {
            sessions(+1);
            log($"wt open: {claim.User}");
            try
            {
                await Relay.Run(new StreamChannel(bytes), auth => Authorize(claim, auth), m => log($"{claim.User}: {m}"), cts.Token);
            }
            catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException or QuicNativeException)
            {
            }
            catch (Exception e)
            {
                log($"wt relay error: {e.Message}");
            }
            finally
            {
                sessions(-1);
                await bytes.DisposeAsync();
                session.Close(0, "");
                cts.Dispose();
                log($"wt close: {claim.User}");
            }
        });
    }

    public void OnClosed(WebTransportSession session, uint code, string reason)
    {
        if (session.State is not Claim claim) return;
        claim.Wait?.Dispose();
        // Gate を持ったまま中継の後始末を走らせない
        if (claim.Cts is { } cts)
            _ = Task.Run(() =>
            {
                try { cts.Cancel(); }
                catch (ObjectDisposedException) { }
            });
    }
}
