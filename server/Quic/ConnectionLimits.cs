using System.Net;

namespace Mado.Quic;

/// <summary>
/// QUIC の接続の数の上限。ログインを確かめる前(正しい CONNECT がまだ来ていない)の接続は特に絞る。
/// 確かめる前の接続は、全体で maxPreAuth、同じ IP から maxPreAuthPerIp まで。全部で maxTotal まで
/// </summary>
internal sealed class ConnectionLimits(int maxTotal = 64, int maxPreAuth = 16, int maxPreAuthPerIp = 4)
{
    readonly Lock _lock = new();
    readonly Dictionary<IPAddress, int> _preAuthByIp = [];
    int _total;
    int _preAuth;

    public int Total { get { lock (_lock) return _total; } }
    public int PreAuth { get { lock (_lock) return _preAuth; } }

    /// <summary>新しい接続を入れてよいか。入れるなら券を返す。だめなら null</summary>
    public Ticket? TryAdmit(IPAddress? ip)
    {
        var key = ip ?? IPAddress.None;
        lock (_lock)
        {
            if (_total >= maxTotal || _preAuth >= maxPreAuth) return null;
            _preAuthByIp.TryGetValue(key, out var n);
            if (n >= maxPreAuthPerIp) return null;
            _preAuthByIp[key] = n + 1;
            _total++;
            _preAuth++;
            return new Ticket(this, key);
        }
    }

    void LeavePreAuth(IPAddress key)
    {
        _preAuth--;
        if (--_preAuthByIp[key] == 0) _preAuthByIp.Remove(key);
    }

    /// <summary>1 つの接続の券。Authenticated と Release は何度呼んでもよい</summary>
    public sealed class Ticket(ConnectionLimits owner, IPAddress key)
    {
        bool _preAuth = true;
        bool _released;

        /// <summary>正しい CONNECT が来た。確かめる前の数から外す</summary>
        public void Authenticated()
        {
            lock (owner._lock)
            {
                if (_released || !_preAuth) return;
                _preAuth = false;
                owner.LeavePreAuth(key);
            }
        }

        /// <summary>接続が終わった</summary>
        public void Release()
        {
            lock (owner._lock)
            {
                if (_released) return;
                _released = true;
                if (_preAuth) owner.LeavePreAuth(key);
                owner._total--;
            }
        }
    }
}
