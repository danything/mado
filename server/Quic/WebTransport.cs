// HTTP/3 の接続と WebTransport のセッション。
// Chrome(quiche)は WebTransport over HTTP/3 の draft-02 と draft-07 を知っている。
// Chrome 141 で確かめると、Chrome の SETTINGS は ENABLE_WEBTRANSPORT(0x2b603742、draft-02)だけだった。
// 決まりごと:
// - サーバーは SETTINGS で ENABLE_CONNECT_PROTOCOL=1、H3_DATAGRAM=1 と、ENABLE_WEBTRANSPORT=1(draft-02)
//   または WEBTRANSPORT_MAX_SESSIONS(0xc671706a)>0(draft-07)を送る。両方送れば Chrome が高い方を選ぶ。
//   Chrome はサーバーの SETTINGS が届くまで CONNECT を送らない
// - draft-02 では応答に sec-webtransport-http3-draft: draft02 が要る
// - セッションは拡張 CONNECT(:method CONNECT、:protocol webtransport)の要求 stream。2xx を返すと始まる
// - 双方向の stream は先頭に 0x41 とセッション ID(CONNECT の stream ID)を置く。その後は生のバイト
// - 単方向の stream は stream の型 0x54 とセッション ID を置く
// - datagram は「CONNECT の stream ID / 4」を可変長整数で置き、その後に中身
// - CONNECT の stream の本体は capsule(RFC 9297)。CLOSE_WEBTRANSPORT_SESSION(0x2843)で閉じる
// このファイルのコールバックは、どれも接続の Gate を持った状態で呼ばれる。
using System.Text;

namespace Mado.Quic;

/// <summary>受け入れたセッションの扱い手。mado では RDCleanPath の中継</summary>
internal interface IWebTransportHandler
{
    /// <summary>CONNECT を受けたとき。200 で受け入れる。ほかの値はその状態で断る</summary>
    int Accept(WebTransportSession session);
    /// <summary>相手が開いた双方向 stream。先頭の 0x41 とセッション ID を読んだ後に呼ぶ</summary>
    void OnBidiStream(WebTransportSession session, WebTransportStream stream);
    /// <summary>相手が開いた単方向 stream。既定では受け取りを断る</summary>
    void OnUniStream(WebTransportSession session, WebTransportStream stream) => stream.Abort(H3.NoError);
    void OnDatagram(WebTransportSession session, ReadOnlySpan<byte> data) { }
    void OnClosed(WebTransportSession session, uint code, string reason) { }
}

/// <summary>HTTP/3 の 1 接続。QUIC の接続ごとに 1 つ作る</summary>
internal sealed class Http3Connection
{
    // サーバーが送る SETTINGS。動的表は使わない
    static readonly (ulong, ulong)[] ServerSettings =
    [
        (H3.SettingQpackMaxTableCapacity, 0),
        (H3.SettingQpackBlockedStreams, 0),
        (H3.SettingEnableConnectProtocol, 1),
        (H3.SettingH3Datagram, 1),
        // Chrome 141 は draft-02 だけを宣言してくる。draft-07 の宣言も並べ、両方が話せる版を選ばせる
        (H3.SettingEnableWebTransportDraft02, 1),
        (H3.SettingWebTransportMaxSessionsDraft07, 1),
    ];

    readonly QuicConnection _quic;
    readonly IWebTransportHandler _handler;
    readonly Action<string> _log;
    readonly Dictionary<ulong, WebTransportSession> _sessions = [];
    // セッションより先に着いた stream。CONNECT の処理の後に渡す
    readonly Dictionary<ulong, List<WebTransportStream>> _early = [];
    bool _peerSettingsSeen;
    bool _closed;
    // セッションの無いあいだ動く時計。SessionWait のうちに CONNECT が来なければ接続を閉じる
    Timer? _wait;

    /// <summary>
    /// セッションが無いまま待つ時間。握手の後とセッションが終わった後に数え始める。
    /// keep-alive があるので、これが無いと何もしない接続がいつまでも残る
    /// </summary>
    public TimeSpan SessionWait { get; init; } = TimeSpan.FromSeconds(10);
    /// <summary>扱い手が CONNECT を受け入れた(ログインを確かめた)。接続の数の上限に使う</summary>
    public Action? OnAuthenticated { get; init; }

    public Http3Connection(QuicConnection quic, IWebTransportHandler handler, Action<string> log)
    {
        _quic = quic;
        _handler = handler;
        _log = log;
        quic.OnConnected = _ => Connected();
        quic.OnPeerStream = (_, s, uni) => { if (uni) AcceptUni(s); else AcceptBidi(s); };
        quic.OnDatagram = (_, d) => Datagram(d);
        quic.OnClosed = _ => Closed();
        quic.OnError = e => _log($"webtransport: コールバックで例外: {e.Message}");
    }

    public QuicConnection Quic => _quic;

    void Connected()
    {
        // 制御 stream(型 0x00)。先頭のフレームは SETTINGS でなければならない
        var w = new ByteWriter();
        w.VarInt(H3.StreamControl).Bytes(H3.Settings(ServerSettings));
        _quic.OpenStream(unidirectional: true).Send(w.Span);
        // QPACK の encoder / decoder stream。動的表を使わないので型だけ送る
        _quic.OpenStream(unidirectional: true).Send([(byte)H3.StreamQpackEncoder]);
        _quic.OpenStream(unidirectional: true).Send([(byte)H3.StreamQpackDecoder]);
        ArmWait();
    }

    void ArmWait()
    {
        _wait?.Dispose();
        _wait = new Timer(_ =>
        {
            lock (_quic.Gate)
            {
                if (_closed || _sessions.Count > 0) return;
                _log("webtransport: CONNECT が来ないので接続を閉じる");
                _quic.Shutdown(H3.NoError);
            }
        }, null, SessionWait, Timeout.InfiniteTimeSpan);
    }

    void Closed()
    {
        _closed = true;
        _wait?.Dispose();
        _wait = null;
        foreach (var s in _sessions.Values.ToArray()) s.Terminate(0, "接続が閉じた");
        _sessions.Clear();
        foreach (var list in _early.Values)
            foreach (var ws in list) ws.Abort(WebTransportSession.ErrorSessionGone);
        _early.Clear();
    }

    /// <summary>接続ごと閉じる(HTTP/3 の誤り)</summary>
    void Fail(ulong code, string why)
    {
        _log($"webtransport: 接続の誤り 0x{code:x}: {why}");
        _quic.Shutdown(code);
    }

    // ===== 単方向 stream =====

    void AcceptUni(QuicStream s)
    {
        var buf = new RecvBuffer();
        s.OnReceive = (st, data, fin) =>
        {
            buf.Append(data);
            if (!VarInt.TryRead(buf.Data, out var type, out var n))
            {
                if (fin || buf.Count > 8) st.Abort(H3.NoError);
                return;
            }
            buf.Consume(n);
            switch (type)
            {
                case H3.StreamControl: ControlStream(st, buf, fin); break;
                case H3.StreamQpackEncoder:
                case H3.StreamQpackDecoder:
                    // 動的表を許していないので、中身は読み捨てる。閉じられたら接続の誤り
                    st.OnReceive = (_, _, f) => { if (f) Fail(H3.ClosedCriticalStream, "QPACK の stream が閉じた"); };
                    break;
                case H3.StreamWebTransportUni: WtUniStream(st, buf, fin); break;
                default:
                    // push や GREASE や知らない型。受け取りを断る
                    st.OnReceive = null;
                    st.StopReceiving(H3.StreamCreationError);
                    break;
            }
        };
    }

    void ControlStream(QuicStream s, RecvBuffer buf, bool fin)
    {
        s.OnReceive = (st, data, f) =>
        {
            buf.Append(data);
            while (true)
            {
                if (!H3.TryReadFrame(buf.Data, 16384, out var type, out var hl, out var pl, out var tooLarge))
                {
                    if (tooLarge) { Fail(H3.ExcessiveLoad, "制御 stream のフレームが大きすぎる"); return; }
                    break;
                }
                var payload = buf.Data.Slice(hl, pl);
                if (!_peerSettingsSeen)
                {
                    if (type != H3.FrameSettings) { Fail(H3.MissingSettings, "最初のフレームが SETTINGS でない"); return; }
                    // 中身は使わない。形だけ確かめる
                    if (H3.ParseSettings(payload) is null) { Fail(H3.SettingsError, "SETTINGS が読めない"); return; }
                    _peerSettingsSeen = true;
                }
                else if (type == H3.FrameSettings) { Fail(H3.FrameUnexpected, "SETTINGS が 2 度来た"); return; }
                else if (type is H3.FrameData or H3.FrameHeaders || H3.IsHttp2Only(type)) { Fail(H3.FrameUnexpected, $"制御 stream に型 0x{type:x}"); return; }
                // GOAWAY、MAX_PUSH_ID、CANCEL_PUSH、GREASE、知らない型は読み飛ばす
                buf.Consume(hl + pl);
            }
            if (f) Fail(H3.ClosedCriticalStream, "制御 stream が閉じた");
        };
        s.OnReceive(s, default, fin);
    }

    void WtUniStream(QuicStream s, RecvBuffer buf, bool fin)
    {
        s.OnReceive = (st, data, f) =>
        {
            buf.Append(data);
            if (!VarInt.TryRead(buf.Data, out var sessionId, out var n))
            {
                if (f || buf.Count > 8) st.Abort(H3.NoError);
                return;
            }
            buf.Consume(n);
            var ws = new WebTransportStream(st, sessionId, bidirectional: false);
            Attach(ws);
            if (buf.Count > 0 || f) ws.Deliver(buf.Data, f);
        };
        s.OnReceive(s, default, fin);
    }

    // ===== 双方向 stream =====

    void AcceptBidi(QuicStream s)
    {
        var buf = new RecvBuffer();
        s.OnReceive = (st, data, fin) =>
        {
            buf.Append(data);
            if (!VarInt.TryRead(buf.Data, out var first, out var n))
            {
                if (fin) st.Abort(H3.RequestIncomplete);
                return;
            }
            if (first == H3.WebTransportBidiSignal)
            {
                if (!VarInt.TryRead(buf.Data[n..], out var sessionId, out var n2))
                {
                    if (fin) st.Abort(H3.RequestIncomplete);
                    return;
                }
                buf.Consume(n + n2);
                var ws = new WebTransportStream(st, sessionId, bidirectional: true);
                Attach(ws);
                if (buf.Count > 0 || fin) ws.Deliver(buf.Data, fin);
            }
            else
            {
                new RequestStream(this, st, buf).Receive(default, fin);
            }
        };
    }

    /// <summary>WebTransport の stream をセッションに結ぶ。セッションがまだ無ければ待たせる</summary>
    void Attach(WebTransportStream ws)
    {
        if (_sessions.TryGetValue(ws.SessionId, out var session))
        {
            Hand(session, ws);
            return;
        }
        // 知らないセッションの stream は少しだけ待たせる。CONNECT の応答より先に着くことがある
        if (!_early.TryGetValue(ws.SessionId, out var list))
        {
            if (_early.Count >= 4) { ws.Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
            _early[ws.SessionId] = list = [];
        }
        if (list.Count >= 16) { ws.Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
        ws.Buffering = true;
        list.Add(ws);
    }

    void Hand(WebTransportSession session, WebTransportStream ws)
    {
        session.Add(ws);
        if (ws.Bidirectional) _handler.OnBidiStream(session, ws);
        else _handler.OnUniStream(session, ws);
    }

    /// <summary>要求 stream の HEADERS を受けた</summary>
    internal void OnRequest(RequestStream req, List<(string Name, string Value)> headers)
    {
        // WebTransport の CONNECT 以外は扱わない
        int check = ConnectRequest.Parse(headers, out var connect);
        if (check != 200)
        {
            req.Respond(check.ToString(System.Globalization.CultureInfo.InvariantCulture), fin: true);
            return;
        }

        // 1 つの接続にセッションは 1 つだけ。トークンを使う前に断る
        if (_sessions.Count > 0)
        {
            req.Respond("429", fin: true);
            return;
        }

        var session = new WebTransportSession(this, req, connect);
        int status = _handler.Accept(session);
        if (status != 200)
        {
            req.Session = null;
            req.Respond(status.ToString(System.Globalization.CultureInfo.InvariantCulture), fin: true);
            return;
        }
        _sessions[session.Id] = session;
        _wait?.Dispose();
        _wait = null;
        OnAuthenticated?.Invoke();
        // draft-02 の頃の Chrome はこのヘッダーを確かめていた。今は見ないが、付けても害は無い
        req.Respond("200", fin: false, extra: [("sec-webtransport-http3-draft", "draft02")]);

        if (_early.Remove(session.Id, out var waiting))
            foreach (var ws in waiting)
            {
                ws.Buffering = false;
                Hand(session, ws);
                ws.Flush();
            }
    }

    internal void OnSessionClosed(WebTransportSession session, uint code, string reason)
    {
        if (!_sessions.Remove(session.Id)) return;
        _handler.OnClosed(session, code, reason);
        if (_sessions.Count == 0 && !_closed) ArmWait();
    }

    void Datagram(ReadOnlySpan<byte> d)
    {
        // 先頭は Quarter Stream ID(CONNECT の stream ID / 4)
        if (!VarInt.TryRead(d, out var q, out var n)) { Fail(H3.DatagramError, "datagram が短い"); return; }
        if (_sessions.TryGetValue(q * 4, out var session)) _handler.OnDatagram(session, d[n..]);
        // セッションが無ければ捨てる。閉じた直後に届くことがある
    }
}

/// <summary>拡張 CONNECT(RFC 9220)の要求。WebTransport のときだけ受ける</summary>
internal readonly record struct ConnectRequest(string Authority, string Path, string Origin)
{
    /// <summary>ヘッダーを確かめる。200 なら request に中身が入る。CONNECT 以外は 404、形が違えば 400</summary>
    public static int Parse(List<(string Name, string Value)> headers, out ConnectRequest request)
    {
        request = default;
        var seen = new Dictionary<string, string>();
        foreach (var (name, value) in headers)
        {
            // 疑似ヘッダーが 2 つあるのは誤り(RFC 9114 4.3)
            if (name.StartsWith(':') && seen.ContainsKey(name)) return 400;
            seen.TryAdd(name, value);
        }
        string? Get(string name) => seen.GetValueOrDefault(name);
        if (Get(":method") != "CONNECT") return 404;
        var authority = Get(":authority");
        var path = Get(":path");
        if (Get(":protocol") != "webtransport" || Get(":scheme") != "https"
            || string.IsNullOrEmpty(authority) || string.IsNullOrEmpty(path) || !path.StartsWith('/'))
            return 400;
        request = new ConnectRequest(authority, path, Get("origin") ?? "");
        return 200;
    }
}

/// <summary>HTTP の要求 stream。WebTransport では CONNECT の stream がセッションそのものになる</summary>
internal sealed class RequestStream
{
    readonly Http3Connection _conn;
    readonly RecvBuffer _buf;
    readonly RecvBuffer _capsules = new();
    bool _headersSeen;
    public QuicStream Stream { get; }
    public WebTransportSession? Session;

    public RequestStream(Http3Connection conn, QuicStream stream, RecvBuffer buf)
    {
        _conn = conn;
        Stream = stream;
        _buf = buf;
        stream.OnReceive = (_, data, fin) => Receive(data, fin);
        stream.OnPeerAbort = (_, code) => Session?.Terminate(0, $"CONNECT の stream が打ち切られた 0x{code:x}");
        stream.OnClosed += _ => Session?.Terminate(0, "CONNECT の stream が閉じた");
    }

    public void Receive(ReadOnlySpan<byte> data, bool fin)
    {
        _buf.Append(data);
        while (true)
        {
            if (!H3.TryReadFrame(_buf.Data, 65536, out var type, out var hl, out var pl, out var tooLarge))
            {
                if (tooLarge) { Stream.Abort(H3.ExcessiveLoad); return; }
                break;
            }
            var payload = _buf.Data.Slice(hl, pl);
            if (type == H3.FrameHeaders)
            {
                if (_headersSeen)
                {
                    // CONNECT の後ろに trailer は来ない
                    Stream.Abort(H3.MessageError);
                    return;
                }
                _headersSeen = true;
                List<(string, string)> headers;
                try { headers = Qpack.Decode(payload); }
                catch (QpackException)
                {
                    _conn.Quic.Shutdown(H3.QpackDecompressionFailed);
                    return;
                }
                _buf.Consume(hl + pl);
                _conn.OnRequest(this, headers);
                if (Session is null) return; // 断った
                continue;
            }
            if (type == H3.FrameData)
            {
                if (!_headersSeen) { Stream.Abort(H3.FrameUnexpected); return; }
                _capsules.Append(payload);
                _buf.Consume(hl + pl);
                if (!ReadCapsules()) return;
                continue;
            }
            if (type is H3.FrameSettings or H3.FrameGoAway or H3.FrameMaxPushId or H3.FrameCancelPush or H3.FramePushPromise || H3.IsHttp2Only(type))
            {
                _conn.Quic.Shutdown(H3.FrameUnexpected);
                return;
            }
            // GREASE や知らない型は読み飛ばす
            _buf.Consume(hl + pl);
        }
        if (fin)
        {
            if (!_headersSeen) { Stream.Abort(H3.RequestIncomplete); return; }
            // 相手が CONNECT の送信側を閉じた。セッションの終わり
            Session?.OnPeerFin();
        }
    }

    /// <summary>capsule(型、長さ、中身)を読む。誤りで打ち切ったら false</summary>
    bool ReadCapsules()
    {
        while (true)
        {
            var d = _capsules.Data;
            if (!VarInt.TryRead(d, out var type, out var n1)) return true;
            if (!VarInt.TryRead(d[n1..], out var len, out var n2)) return true;
            if (len > 65536) { Stream.Abort(H3.MessageError); return false; }
            if (d.Length < n1 + n2 + (int)len) return true;
            Session?.OnCapsule(type, d.Slice(n1 + n2, (int)len));
            _capsules.Consume(n1 + n2 + (int)len);
        }
    }

    public void Respond(string status, bool fin, (string, string)[]? extra = null)
    {
        var fields = new List<(string, string)> { (":status", status) };
        if (extra != null) fields.AddRange(extra);
        Stream.Send(H3.Frame(H3.FrameHeaders, Qpack.Encode(fields)), fin);
    }

    /// <summary>capsule を DATA フレームに入れて送る</summary>
    public void SendCapsule(ulong type, ReadOnlySpan<byte> payload, bool fin)
    {
        var c = new ByteWriter();
        c.VarInt(type).VarInt((ulong)payload.Length).Bytes(payload);
        Stream.Send(H3.Frame(H3.FrameData, c.Span), fin);
    }
}

/// <summary>WebTransport の 1 セッション。ID は CONNECT の stream ID</summary>
internal sealed class WebTransportSession
{
    public const ulong CapsuleCloseSession = 0x2843;
    // stream を打ち切るときの番号(draft-ietf-webtrans-http3)
    public const ulong ErrorSessionGone = 0x170d7b68;
    public const ulong ErrorBufferedStreamRejected = 0x3994bd84;

    readonly Http3Connection _conn;
    readonly RequestStream _connect;
    readonly List<WebTransportStream> _streams = [];
    bool _closed;
    bool _finSent;

    public ulong Id { get; }
    public string Path { get; }
    public string Origin { get; }
    /// <summary>扱い手が好きに使う</summary>
    public object? State;

    public WebTransportSession(Http3Connection conn, RequestStream connect, ConnectRequest request)
    {
        _conn = conn;
        _connect = connect;
        connect.Session = this;
        Id = connect.Stream.Id;
        Path = request.Path;
        Origin = request.Origin;
    }

    internal void Add(WebTransportStream s)
    {
        s.Session = this;
        _streams.Add(s);
        s.Stream.OnClosed += _ => _streams.Remove(s);
    }

    /// <summary>こちらから閉じる。CLOSE_WEBTRANSPORT_SESSION を送って CONNECT の stream に FIN を付ける。どのスレッドからでも呼べる</summary>
    public void Close(uint code, string reason)
    {
        lock (_conn.Quic.Gate)
        {
            if (_closed) return;
            var p = new ByteWriter();
            p.UInt32BE(code);
            var r = Encoding.UTF8.GetBytes(reason);
            p.Bytes(r.AsSpan(0, Math.Min(r.Length, 1024)));
            try { _connect.SendCapsule(CapsuleCloseSession, p.Span, fin: true); }
            catch (QuicNativeException) { }
            _finSent = true;
            Terminate(code, reason);
        }
    }

    internal void OnCapsule(ulong type, ReadOnlySpan<byte> payload)
    {
        if (type == CapsuleCloseSession)
        {
            uint code = payload.Length >= 4 ? System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(payload) : 0;
            string reason = payload.Length > 4 ? Encoding.UTF8.GetString(payload[4..]) : "";
            Terminate(code, reason);
            FinConnect();
        }
        // DRAIN とほかの capsule は読み飛ばす
    }

    internal void OnPeerFin()
    {
        Terminate(0, "相手が CONNECT の stream を閉じた");
        FinConnect();
    }

    void FinConnect()
    {
        if (_finSent) return;
        _finSent = true;
        _connect.Stream.Finish();
    }

    /// <summary>セッションを終える。残った stream は WT_SESSION_GONE で打ち切る</summary>
    internal void Terminate(uint code, string reason)
    {
        if (_closed) return;
        _closed = true;
        foreach (var s in _streams.ToArray()) s.Abort(ErrorSessionGone);
        _streams.Clear();
        _conn.OnSessionClosed(this, code, reason);
    }
}

/// <summary>WebTransport の stream。先頭の印(0x41 / 0x54 とセッション ID)を読んだ後の生のバイトを運ぶ</summary>
internal sealed class WebTransportStream
{
    public QuicStream Stream { get; }
    public ulong SessionId { get; }
    public bool Bidirectional { get; }
    public WebTransportSession? Session { get; internal set; }

    public delegate void DataHandler(WebTransportStream s, ReadOnlySpan<byte> data, bool fin);
    /// <summary>届いたバイト。fin は相手が送り終えた印</summary>
    public DataHandler? OnData;

    // セッションが決まるまで溜めておく
    internal bool Buffering;
    RecvBuffer? _pending;
    bool _pendingFin;

    public WebTransportStream(QuicStream stream, ulong sessionId, bool bidirectional)
    {
        Stream = stream;
        SessionId = sessionId;
        Bidirectional = bidirectional;
        stream.OnReceive = (_, d, fin) => Deliver(d, fin);
    }

    internal void Deliver(ReadOnlySpan<byte> data, bool fin)
    {
        if (Buffering)
        {
            _pending ??= new RecvBuffer();
            if (_pending.Count + data.Length > 64 * 1024) { Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
            _pending.Append(data);
            _pendingFin |= fin;
            return;
        }
        OnData?.Invoke(this, data, fin);
    }

    internal void Flush()
    {
        if (_pending == null) return;
        var p = _pending;
        _pending = null;
        if (p.Count > 0 || _pendingFin) OnData?.Invoke(this, p.Data, _pendingFin);
    }

    public void Abort(ulong code) => Stream.Abort(code);
}

/// <summary>
/// WebTransport の双方向 stream を System.IO.Stream として読み書きする。中継(Relay)が使う。
/// 受信は溜める。HighWater を超えたら msquic の受信を止め、読まれて LowWater を切ったら戻す。
/// 送信は msquic がバッファを返すまで待つ。どちらも溜め込みは一定の量で止まる
/// </summary>
internal sealed class WebTransportByteStream : Stream
{
    const int HighWater = 1 << 20;
    const int LowWater = 256 << 10;

    readonly WebTransportStream _ws;
    readonly Lock _lock = new();
    readonly Queue<byte[]> _chunks = new();
    int _offset; // 先頭のかたまりの読んだところ
    int _queued;
    bool _fin;
    bool _paused;
    Exception? _error;
    TaskCompletionSource? _waiter;
    TaskCompletionSource? _closing;

    public WebTransportByteStream(WebTransportStream ws)
    {
        _ws = ws;
        ws.OnData = (_, data, fin) => Push(data, fin);
        ws.Stream.OnPeerAbort = (_, code) => Fail(new IOException($"相手が stream を打ち切った (0x{code:x})"));
        ws.Stream.OnClosed += _ => Fail(new IOException("stream が閉じた"));
    }

    void Push(ReadOnlySpan<byte> data, bool fin)
    {
        bool pause = false;
        TaskCompletionSource? w;
        lock (_lock)
        {
            if (!data.IsEmpty)
            {
                _chunks.Enqueue(data.ToArray());
                _queued += data.Length;
            }
            _fin |= fin;
            if (_queued > HighWater && !_paused) { _paused = true; pause = true; }
            w = _waiter;
            _waiter = null;
        }
        if (pause) _ws.Stream.SetReceiveEnabled(false);
        w?.TrySetResult();
    }

    void Fail(Exception e)
    {
        TaskCompletionSource? w;
        lock (_lock)
        {
            _error ??= e;
            w = _waiter;
            _waiter = null;
        }
        w?.TrySetResult();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        if (buffer.IsEmpty) return 0;
        while (true)
        {
            Task wait;
            int n = 0;
            bool resume = false;
            lock (_lock)
            {
                if (_queued > 0)
                {
                    while (n < buffer.Length && _chunks.Count > 0)
                    {
                        var c = _chunks.Peek();
                        int k = Math.Min(c.Length - _offset, buffer.Length - n);
                        c.AsSpan(_offset, k).CopyTo(buffer.Span[n..]);
                        n += k;
                        _offset += k;
                        if (_offset == c.Length) { _chunks.Dequeue(); _offset = 0; }
                    }
                    _queued -= n;
                    if (_paused && _queued < LowWater) { _paused = false; resume = true; }
                    wait = Task.CompletedTask;
                }
                else if (_fin) return 0;
                else if (_error is not null) throw _error;
                else
                {
                    _waiter ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    wait = _waiter.Task;
                }
            }
            if (n > 0)
            {
                // msquic の API は Gate を取る。_lock を放してから呼ぶ(コールバックは Gate → _lock の順で取る)
                if (resume) _ws.Stream.SetReceiveEnabled(true);
                return n;
            }
            await wait.WaitAsync(ct);
        }
    }
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        if (buffer.IsEmpty) return;
        await _ws.Stream.SendAsync(buffer.Span).WaitAsync(ct);
    }

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();
    public override void Flush() { }
    public override bool CanRead => true;
    public override bool CanWrite => true;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();

    /// <summary>
    /// 閉じる。送信側に FIN を付け、相手が最後まで受け取るのを待つ(長くて 5 秒)。
    /// 待たずにセッションを閉じると、相手は stream を打ち切り、まだ読んでいない最後のデータ(RDCleanPath の誤りなど)が消える。
    /// 何度呼んでもよい。2 度目からは 1 度目と同じ終わりを待つ
    /// </summary>
    public override ValueTask DisposeAsync() => new(Finish());

    /// <summary>閉じる。送信側に FIN を付ける。待たない</summary>
    protected override void Dispose(bool disposing)
    {
        if (disposing) _ = Finish();
        base.Dispose(disposing);
    }

    // 1 度だけ閉じる。msquic の API は Gate を取るので、_lock は持たずに呼ぶ
    Task Finish()
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (Interlocked.CompareExchange(ref _closing, tcs, null) is { } first) return first.Task;
        _ws.Stream.Finish();
        _ = _ws.Stream.SendDone.WaitAsync(TimeSpan.FromSeconds(5))
            .ContinueWith(_ => tcs.TrySetResult(), TaskScheduler.Default);
        return tcs.Task;
    }
}
