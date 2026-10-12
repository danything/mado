using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography.X509Certificates;

namespace Mado.Quic;

/// <summary>
/// WebTransport(HTTP/3)の待ち受け。UDP の 1 つの port で、受けた接続を Http3Connection に渡す。
/// 証明書は SetCertificate で渡す。最初に渡したときに待ち受けを始め、取り直したら次の接続から新しい証明書を使う。
/// 輻輳制御は BBR。RDP の画面の更新は大きく、損失のある回線で CUBIC より速度を保ちやすい
/// </summary>
internal sealed class WebTransportServer : IDisposable
{
    readonly QuicRegistration _reg;
    readonly IWebTransportHandler _handler;
    readonly IPAddress? _ip;
    readonly ushort _port;
    readonly Action<string> _log;
    // _config の差し替えと、listener のコールバックが付けるのを重ねない
    readonly Lock _configLock = new();
    // SetCertificate と Dispose を重ねない。ListenerClose はコールバックの終わりを待つので、_configLock とは分ける
    readonly Lock _stateLock = new();
    // 接続が終わるまで参照を持つ
    readonly ConcurrentDictionary<QuicConnection, (Http3Connection H3, ConnectionLimits.Ticket Ticket)> _connections = new();
    readonly ConnectionLimits _limits = new();
    QuicServerConfig? _config;
    QuicListener? _listener;
    bool _disposed;

    WebTransportServer(QuicRegistration reg, IWebTransportHandler handler, IPAddress? ip, ushort port, Action<string> log)
    {
        _reg = reg;
        _handler = handler;
        _ip = ip;
        _port = port;
        _log = log;
    }

    /// <summary>msquic を読む。読めなければログに書いて null(WebSocket だけで動く)</summary>
    public static WebTransportServer? TryCreate(IWebTransportHandler handler, IPAddress? ip, ushort port, Action<string> log)
    {
        try
        {
            var reg = new QuicRegistration("mado");
            log($"webtransport: msquic {MsQuic.Version()}");
            return new WebTransportServer(reg, handler, ip, port, log);
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or QuicNativeException)
        {
            log($"webtransport: 使えない ({e.Message})。WebSocket だけで動く");
            return null;
        }
    }

    public bool IsListening => _listener is not null;

    public static QuicSettings Settings()
    {
        var s = new QuicSettings();
        s.Set(QuicSettings.IsSetCongestionControlAlgorithm);
        s.CongestionControlAlgorithm = MsQuic.CongestionBbr;
        s.Set(QuicSettings.IsSetIdleTimeoutMs);
        s.IdleTimeoutMs = 60_000;
        // 画面が止まっていると何も流れないことがある。NAT の対応を切らさないよう、こちらから時々送る
        s.Set(QuicSettings.IsSetKeepAliveIntervalMs);
        s.KeepAliveIntervalMs = 15_000;
        // 相手が開ける stream の数。双方向は CONNECT と中継の 2 本で足りる。
        // 単方向は制御と QPACK の 2 本に、Chrome が送る GREASE の分を足す
        s.Set(QuicSettings.IsSetPeerBidiStreamCount);
        s.PeerBidiStreamCount = 8;
        s.Set(QuicSettings.IsSetPeerUnidiStreamCount);
        s.PeerUnidiStreamCount = 8;
        // H3_DATAGRAM を宣言するので、QUIC の datagram も受けられるようにしておく(中身は使わない)
        s.Set(QuicSettings.IsSetDatagramReceiveEnabled);
        s.Bits |= QuicSettings.BitDatagramReceive;
        return s;
    }

    /// <summary>
    /// 証明書と鍵(PEM)を msquic に渡す。中間証明書も一緒に送るように、全部を 1 つの PKCS#12 にする。
    /// 最初の 1 回で待ち受けを始める。失敗したらログに書いて、WebTransport なしで続ける
    /// </summary>
    public void SetCertificate(string keyPem, string certPem)
    {
        lock (_stateLock)
        {
            if (_disposed) return;
            SetCertificateLocked(keyPem, certPem);
        }
    }

    void SetCertificateLocked(string keyPem, string certPem)
    {
        try
        {
            var config = new QuicServerConfig(_reg, "h3", Settings(), Pkcs12(keyPem, certPem), null);
            QuicServerConfig? old;
            lock (_configLock)
            {
                old = _config;
                _config = config;
            }
            old?.Dispose();
            if (_listener is null)
            {
                var back = config.ReadBack();
                _listener = new QuicListener(_reg, ConfigureNew, OnConnection);
                _listener.Start("h3", _ip, _port);
                _log($"webtransport: UDP {_port} で待ち受け(輻輳制御 {(back.CongestionControlAlgorithm == MsQuic.CongestionBbr ? "BBR" : "CUBIC")})");
            }
        }
        catch (Exception e) when (e is QuicNativeException or System.Security.Cryptography.CryptographicException)
        {
            _log($"webtransport: 待ち受けられない ({e.Message})");
            _listener?.Dispose();
            _listener = null;
        }
    }

    /// <summary>listener のコールバックから呼ぶ。差し替えと重ならないように、今の configuration を付ける</summary>
    int ConfigureNew(QuicConnection conn)
    {
        lock (_configLock)
        {
            int st = _config is null ? -1 : conn.SetConfiguration(_config.Handle);
            if ((st == -1 || MsQuic.Failed(st)) && _connections.TryRemove(conn, out var e)) e.Ticket.Release();
            return st;
        }
    }

    /// <summary>上限を超えていれば断る。ログを確かめる前の接続は、全体と同じ IP からの数を特に絞る</summary>
    bool OnConnection(QuicConnection conn)
    {
        if (_limits.TryAdmit(conn.RemoteAddress) is not { } ticket) return false;
        var h3 = new Http3Connection(conn, _handler, _log) { OnAuthenticated = ticket.Authenticated };
        _connections[conn] = (h3, ticket);
        var prev = conn.OnClosed;
        conn.OnClosed = c =>
        {
            prev?.Invoke(c);
            if (_connections.TryRemove(c, out var e)) e.Ticket.Release();
        };
        return true;
    }

    internal static byte[] Pkcs12(string keyPem, string certPem)
    {
        using var leaf = X509Certificate2.CreateFromPem(certPem, keyPem);
        var all = new X509Certificate2Collection();
        all.ImportFromPem(certPem);
        var col = new X509Certificate2Collection { leaf };
        foreach (var c in all)
            if (c.Thumbprint != leaf.Thumbprint) col.Add(c);
        return col.Export(X509ContentType.Pkcs12)!;
    }

    public void Dispose()
    {
        lock (_stateLock)
        {
            if (_disposed) return;
            _disposed = true;
            _listener?.Dispose();
            _listener = null;
            // 接続を閉じ始めるだけで、終わるのは待たない。サービスの停止を長引かせない
            _reg.Shutdown();
        }
    }
}
