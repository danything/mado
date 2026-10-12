using Mado.Quic;

namespace Mado;

/// <summary>
/// WebTransport で来たブラウザを RDP へ中継する。/ws と同じ Relay を、最初の双方向 stream の上で動かす。
///
/// 認証は /ws と同じ強さにする。WebTransport の CONNECT には Cookie が付かないので、ログインの確かめ方だけが違う。
/// - Origin が mado 自身(https://host)であること。CONNECT の Origin はブラウザが付け、ページからは変えられない
/// - CONNECT の /wt?token=... に、/api/token の出した使い捨てのトークンがあること。署名と期限と未使用だけを見て、
///   ここではまだ使わない。/ws が Cookie で断るのと同じく、ログインしていない相手には中継の入口(RDCleanPath を読むところ)を見せない
/// - RDCleanPath の proxy_auth が、CONNECT のトークンと同じであること。ここでトークンを使う(2 度目は通らない)
/// トークンは署名付きで、60 秒で切れ、1 度しか使えず、つなぐ先が決まっている。/api/token はログインの Cookie で守られ、
/// CORS でほかのサイトからは中身を読めない。だからトークンを持っているのは、ログインしたページだけ。
/// /ws ではさらにトークンの sub と Cookie の sub が同じことを見るが、トークンを手に入れられるのは Cookie を持つページだけなので、
/// 確かめる相手が増えるだけで、守りの強さは変わらない
/// </summary>
internal sealed class WebTransportRelay(
    string origin,
    Func<string?, (Target Target, string User)?> authorize,
    Func<string, bool> tokenUsable,
    Action<string> log,
    Action<int> sessions,
    CancellationToken stopping) : IWebTransportHandler
{
    public const string Path = "/wt";

    public int Accept(WebTransportSession session) => Check(origin, session.Origin, session.Path, tokenUsable);

    /// <summary>CONNECT を受けるか。Origin が違えば 403、パスが /wt でなければ 404、トークンが使えなければ 401</summary>
    internal static int Check(string origin, string requestOrigin, string path, Func<string, bool> tokenUsable)
    {
        if (requestOrigin != origin) return 403;
        var q = path.IndexOf('?');
        if ((q < 0 ? path : path[..q]) != Path) return 404;
        return TokenOf(path) is { } t && tokenUsable(t) ? 200 : 401;
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

    public void OnBidiStream(WebTransportSession session, WebTransportStream stream)
    {
        // 中継は 1 セッションに 1 本だけ
        if (session.State is not null)
        {
            stream.Abort(H3.RequestRejected);
            return;
        }
        var cts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        session.State = cts;
        var connectToken = TokenOf(session.Path);
        var bytes = new WebTransportByteStream(stream);
        _ = Task.Run(async () =>
        {
            sessions(+1);
            string who = "?";
            log("wt open");
            try
            {
                await Relay.Run(new StreamChannel(bytes), auth =>
                {
                    // CONNECT で見せたのと違うトークンは使わせない
                    if (auth is null || auth != connectToken || authorize(auth) is not { } a) return null;
                    who = a.User;
                    return a.Target;
                }, m => log($"{who}: {m}"), cts.Token);
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
                log($"wt close: {who}");
            }
        });
    }

    public void OnClosed(WebTransportSession session, uint code, string reason)
    {
        // Gate を持ったまま中継の後始末を走らせない
        if (session.State is CancellationTokenSource cts)
            _ = Task.Run(() =>
            {
                try { cts.Cancel(); }
                catch (ObjectDisposedException) { }
            });
    }
}
