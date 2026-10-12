using System.Collections.Concurrent;

namespace Mado;

/// <summary>
/// 中継の使い捨てのトークン。/api/token が出し、/ws は RDCleanPath の proxy_auth で、/wt は CONNECT で使う。
/// 使った jti を期限まで覚えて、2 度目を弾く
/// </summary>
internal sealed class RelayTokens(Signer signer, int ttlSeconds)
{
    readonly ConcurrentDictionary<string, long> _used = new();

    public string Issue(RelayToken t) => signer.Sign(t, ApiJson.Default.RelayToken, ttlSeconds);

    /// <summary>確かめて使う。sub を渡すと、トークンの sub がそれと同じことも見る(/ws は Cookie の sub)。だめなら null</summary>
    public RelayToken? Consume(string? token, string? sub)
    {
        var t = signer.Verify(token, ApiJson.Default.RelayToken);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (t is null || (sub is not null && t.Sub != sub) || !_used.TryAdd(t.Jti, now + ttlSeconds)) return null;
        foreach (var (k, exp) in _used)
            if (exp < now) _used.TryRemove(k, out _);
        return t;
    }
}
