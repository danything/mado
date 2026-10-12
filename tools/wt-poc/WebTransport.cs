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
using System.Collections.Concurrent;
using System.Text;

namespace Mado.WebTransport;

/// <summary>受け入れたセッションの扱い手。mado では RDCleanPath の中継がここに入る。</summary>
internal interface IWebTransportHandler
{
    /// <summary>CONNECT を受けたとき。false で断る(404)。</summary>
    bool Accept(WebTransportSession session);
    /// <summary>相手が開いた双方向 stream。先頭の 0x41 とセッション ID を読んだ後に呼ぶ。</summary>
    void OnBidiStream(WebTransportSession session, WebTransportStream stream);
    void OnUniStream(WebTransportSession session, WebTransportStream stream) { }
    void OnDatagram(WebTransportSession session, ReadOnlySpan<byte> data) { }
    void OnClosed(WebTransportSession session, uint code, string reason) { }
}

/// <summary>HTTP/3 の 1 接続。QUIC の接続ごとに 1 つ作る。コールバックは msquic の同じスレッドから順に来る。</summary>
internal sealed class Http3Connection
{
    // サーバーが送る SETTINGS。動的表は使わない
    static readonly (ulong, ulong)[] ServerSettings =
    [
        (H3.SettingQpackMaxTableCapacity, 0),
        (H3.SettingQpackBlockedStreams, 0),
        (H3.SettingEnableConnectProtocol, 1),
        (H3.SettingH3Datagram, 1),
        // Chrome 141 は draft-02 だけを宣言してくる(0x2b603742=1)。draft-07 の宣言も並べ、両方が話せる版を選ばせる
        (H3.SettingEnableWebTransportDraft02, 1),
        (H3.SettingWebTransportMaxSessionsDraft07, 16),
    ];

    readonly QuicConnection _quic;
    readonly IWebTransportHandler _handler;
    readonly string _name;
    readonly Dictionary<ulong, WebTransportSession> _sessions = [];
    // セッションより先に着いた stream。CONNECT の処理の後に渡す
    readonly Dictionary<ulong, List<WebTransportStream>> _early = [];
    QuicStream? _control;
    bool _peerSettingsSeen;
    public Dictionary<ulong, ulong> PeerSettings { get; private set; } = [];

    public Http3Connection(QuicConnection quic, IWebTransportHandler handler, string name)
    {
        _quic = quic;
        _handler = handler;
        _name = name;
        quic.OnConnected = _ => Connected();
        quic.OnPeerStream = (_, s, uni) => { if (uni) AcceptUni(s); else AcceptBidi(s); };
        quic.OnDatagram = (_, d) => Datagram(d);
        quic.OnShutdown = (_, why) => Log($"接続を閉じる: {why}");
        quic.OnClosed = _ => Closed();
    }

    public QuicConnection Quic => _quic;

    void Log(string s) => Program.Log($"[{_name}] {s}");

    void Connected()
    {
        var st = _quic.ReadSettings();
        Log($"QUIC 接続。輻輳制御={(st.CongestionControlAlgorithm == MsQuic.CongestionBbr ? "BBR" : "CUBIC")} datagram受信={(st.Bits & QuicSettings.BitDatagramReceive) != 0}");
        // 制御 stream(型 0x00)。先頭のフレームは SETTINGS でなければならない
        _control = _quic.OpenStream(unidirectional: true);
        var w = new ByteWriter();
        w.VarInt(H3.StreamControl).Bytes(H3.Settings(ServerSettings));
        _control.Send(w.Span);
        // QPACK の encoder / decoder stream。動的表を使わないので型だけ送る
        _quic.OpenStream(unidirectional: true).Send([(byte)H3.StreamQpackEncoder]);
        _quic.OpenStream(unidirectional: true).Send([(byte)H3.StreamQpackDecoder]);
    }

    void Closed()
    {
        foreach (var s in _sessions.Values) s.Terminate(0, "接続が閉じた");
        _sessions.Clear();
        Log("接続が終わった");
    }

    /// <summary>接続ごと閉じる(HTTP/3 の誤り)。</summary>
    void Fail(ulong code, string why)
    {
        Log($"接続の誤り 0x{code:x}: {why}");
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
                if (fin) st.Abort(H3.NoError);
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
                    var settings = H3.ParseSettings(payload);
                    if (settings == null) { Fail(H3.SettingsError, "SETTINGS が読めない"); return; }
                    PeerSettings = settings;
                    _peerSettingsSeen = true;
                    Log("相手の SETTINGS: " + string.Join(", ", settings.Select(kv => $"0x{kv.Key:x}={kv.Value}")));
                }
                else if (type == H3.FrameSettings) { Fail(H3.FrameUnexpected, "SETTINGS が 2 度来た"); return; }
                else if (type == H3.FrameGoAway) Log("GOAWAY を受けた");
                else if (type is H3.FrameData or H3.FrameHeaders || H3.IsHttp2Only(type)) { Fail(H3.FrameUnexpected, $"制御 stream に型 0x{type:x}"); return; }
                // MAX_PUSH_ID、CANCEL_PUSH、GREASE、知らない型は読み飛ばす
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
                if (f) st.Abort(H3.NoError);
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

    /// <summary>WebTransport の stream をセッションに結ぶ。セッションがまだ無ければ待たせる。</summary>
    void Attach(WebTransportStream ws)
    {
        if (_sessions.TryGetValue(ws.SessionId, out var session))
        {
            session.Add(ws);
            if (ws.Bidirectional) _handler.OnBidiStream(session, ws);
            else _handler.OnUniStream(session, ws);
            return;
        }
        if (!_early.TryGetValue(ws.SessionId, out var list))
        {
            // 待たせすぎない。知らないセッションの stream は 16 本まで
            if (_early.Count >= 4) { ws.Stream.Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
            _early[ws.SessionId] = list = [];
        }
        if (list.Count >= 16) { ws.Stream.Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
        ws.Buffering = true;
        list.Add(ws);
    }

    /// <summary>拡張 CONNECT を受けた。</summary>
    internal void OnConnect(RequestStream req, List<(string Name, string Value)> headers)
    {
        string? Get(string name) => headers.FirstOrDefault(h => h.Name == name).Value;
        var method = Get(":method");
        var protocol = Get(":protocol");
        Log($"要求 stream {req.Stream.Id}: " + string.Join(" ", headers.Select(h => $"{h.Name}={h.Value}")));

        if (method != "CONNECT" || protocol != "webtransport")
        {
            // WebTransport 以外は扱わない
            req.Respond(method == "CONNECT" ? "501" : "404", fin: true);
            return;
        }
        if (!PeerSettings.TryGetValue(H3.SettingH3Datagram, out var dg) || dg != 1)
            Log("相手が H3_DATAGRAM を宣言していない");

        var session = new WebTransportSession(this, req, Get(":authority") ?? "", Get(":path") ?? "", Get("origin") ?? "");
        if (!_handler.Accept(session))
        {
            req.Respond("404", fin: true);
            return;
        }
        _sessions[session.Id] = session;
        // draft-02 の頃の Chrome はこのヘッダーを確かめていた。今は見ないが、付けても害は無い
        req.Respond("200", fin: false, extra: [("sec-webtransport-http3-draft", "draft02")]);
        Log($"セッション {session.Id} を始めた path={session.Path} origin={session.Origin}");

        if (_early.Remove(session.Id, out var waiting))
            foreach (var ws in waiting)
            {
                ws.Buffering = false;
                session.Add(ws);
                if (ws.Bidirectional) _handler.OnBidiStream(session, ws);
                else _handler.OnUniStream(session, ws);
                ws.Flush();
            }
    }

    internal void OnSessionClosed(WebTransportSession session, uint code, string reason)
    {
        if (!_sessions.Remove(session.Id)) return;
        Log($"セッション {session.Id} を閉じた code={code} reason={reason}");
        _handler.OnClosed(session, code, reason);
    }

    void Datagram(ReadOnlySpan<byte> d)
    {
        // 先頭は Quarter Stream ID(CONNECT の stream ID / 4)
        if (!VarInt.TryRead(d, out var q, out var n)) { Fail(H3.DatagramError, "datagram が短い"); return; }
        if (_sessions.TryGetValue(q * 4, out var session)) _handler.OnDatagram(session, d[n..]);
        // セッションが無ければ捨てる(閉じた直後に届くことがある)
    }

    internal void SendDatagram(ulong sessionId, ReadOnlySpan<byte> payload)
    {
        var w = new ByteWriter();
        w.VarInt(sessionId / 4).Bytes(payload);
        _quic.SendDatagram(w.Span);
    }

    internal QuicStream OpenStream(bool unidirectional) => _quic.OpenStream(unidirectional);
}

/// <summary>HTTP の要求 stream。WebTransport では CONNECT の stream がセッションそのものになる。</summary>
internal sealed class RequestStream
{
    readonly Http3Connection _conn;
    readonly RecvBuffer _buf;
    bool _headersSeen;
    public QuicStream Stream { get; }
    public WebTransportSession? Session;
    readonly RecvBuffer _capsules = new();

    public RequestStream(Http3Connection conn, QuicStream stream, RecvBuffer buf)
    {
        _conn = conn;
        Stream = stream;
        _buf = buf;
        stream.OnReceive = (_, data, fin) => Receive(data, fin);
        stream.OnPeerAbort = (_, code) => Session?.Terminate(0, $"CONNECT の stream が打ち切られた 0x{code:x}");
        stream.OnClosed = _ => Session?.Terminate(0, "CONNECT の stream が閉じた");
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
                catch (QpackException e)
                {
                    Program.Log($"QPACK の誤り: {e.Message}");
                    _conn.Quic.Shutdown(H3.QpackDecompressionFailed);
                    return;
                }
                _buf.Consume(hl + pl);
                _conn.OnConnect(this, headers);
                continue;
            }
            if (type == H3.FrameData)
            {
                if (!_headersSeen) { Stream.Abort(H3.FrameUnexpected); return; }
                _capsules.Append(payload);
                _buf.Consume(hl + pl);
                ReadCapsules();
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

    /// <summary>capsule(型、長さ、中身)を読む。</summary>
    void ReadCapsules()
    {
        while (true)
        {
            var d = _capsules.Data;
            if (!VarInt.TryRead(d, out var type, out var n1)) return;
            if (!VarInt.TryRead(d[n1..], out var len, out var n2)) return;
            if (len > 65536) { Stream.Abort(H3.MessageError); return; }
            if (d.Length < n1 + n2 + (int)len) return;
            var payload = d.Slice(n1 + n2, (int)len);
            Session?.OnCapsule(type, payload);
            _capsules.Consume(n1 + n2 + (int)len);
        }
    }

    public void Respond(string status, bool fin, (string, string)[]? extra = null)
    {
        var fields = new List<(string, string)> { (":status", status) };
        if (extra != null) fields.AddRange(extra);
        var frame = H3.Frame(H3.FrameHeaders, Qpack.Encode(fields));
        Stream.Send(frame, fin);
    }

    /// <summary>capsule を DATA フレームに入れて送る。</summary>
    public void SendCapsule(ulong type, ReadOnlySpan<byte> payload, bool fin)
    {
        var c = new ByteWriter();
        c.VarInt(type).VarInt((ulong)payload.Length).Bytes(payload);
        Stream.Send(H3.Frame(H3.FrameData, c.Span), fin);
    }
}

/// <summary>WebTransport の 1 セッション。ID は CONNECT の stream ID。</summary>
internal sealed class WebTransportSession
{
    public const ulong CapsuleCloseSession = 0x2843;
    public const ulong CapsuleDrainSession = 0x78ae;
    // stream を打ち切るときの番号(draft-ietf-webtrans-http3)
    public const ulong ErrorSessionGone = 0x170d7b68;
    public const ulong ErrorBufferedStreamRejected = 0x3994bd84;

    readonly Http3Connection _conn;
    readonly RequestStream _connect;
    readonly List<WebTransportStream> _streams = [];
    bool _closed;
    bool _finSent;

    public ulong Id { get; }
    public string Authority { get; }
    public string Path { get; }
    public string Origin { get; }
    public object? State; // 扱い手が好きに使う

    public WebTransportSession(Http3Connection conn, RequestStream connect, string authority, string path, string origin)
    {
        _conn = conn;
        _connect = connect;
        connect.Session = this;
        Id = connect.Stream.Id;
        Authority = authority;
        Path = path;
        Origin = origin;
    }

    public bool IsClosed => _closed;

    internal void Add(WebTransportStream s)
    {
        s.Session = this;
        _streams.Add(s);
        s.Stream.OnClosed = _ => _streams.Remove(s);
    }

    /// <summary>サーバーから双方向 stream を開く。</summary>
    public WebTransportStream OpenBidi()
    {
        var q = _conn.OpenStream(unidirectional: false);
        var ws = new WebTransportStream(q, Id, bidirectional: true);
        Add(ws);
        var w = new ByteWriter();
        w.VarInt(H3.WebTransportBidiSignal).VarInt(Id);
        q.Send(w.Span);
        return ws;
    }

    /// <summary>サーバーから単方向 stream を開く。</summary>
    public WebTransportStream OpenUni()
    {
        var q = _conn.OpenStream(unidirectional: true);
        var ws = new WebTransportStream(q, Id, bidirectional: false);
        Add(ws);
        var w = new ByteWriter();
        w.VarInt(H3.StreamWebTransportUni).VarInt(Id);
        q.Send(w.Span);
        return ws;
    }

    public void SendDatagram(ReadOnlySpan<byte> payload)
    {
        if (!_closed) _conn.SendDatagram(Id, payload);
    }

    /// <summary>こちらから閉じる。CLOSE_WEBTRANSPORT_SESSION を送って CONNECT の stream に FIN を付ける。</summary>
    public void Close(uint code, string reason)
    {
        if (_closed) return;
        var p = new ByteWriter();
        p.UInt32BE(code);
        var r = Encoding.UTF8.GetBytes(reason);
        p.Bytes(r.AsSpan(0, Math.Min(r.Length, 1024)));
        _connect.SendCapsule(CapsuleCloseSession, p.Span, fin: true);
        _finSent = true;
        Terminate(code, reason);
    }

    internal void OnCapsule(ulong type, ReadOnlySpan<byte> payload)
    {
        if (type == CapsuleCloseSession)
        {
            uint code = payload.Length >= 4 ? System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(payload) : 0;
            string reason = payload.Length > 4 ? Encoding.UTF8.GetString(payload[4..]) : "";
            Program.Log($"セッション {Id}: CLOSE_WEBTRANSPORT_SESSION code={code} reason={reason}");
            Terminate(code, reason);
            FinConnect();
        }
        else if (type == CapsuleDrainSession)
        {
            Program.Log($"セッション {Id}: DRAIN");
        }
        // 他の capsule は読み飛ばす
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
        try { _connect.Stream.Finish(); } catch (QuicNativeException) { }
    }

    /// <summary>セッションを終える。残った stream は WT_SESSION_GONE で打ち切る。</summary>
    internal void Terminate(uint code, string reason)
    {
        if (_closed) return;
        _closed = true;
        foreach (var s in _streams.ToArray()) s.Stream.Abort(ErrorSessionGone);
        _streams.Clear();
        _conn.OnSessionClosed(this, code, reason);
    }
}

/// <summary>WebTransport の stream。先頭の印(0x41 / 0x54 とセッション ID)を読んだ後の生のバイトを運ぶ。</summary>
internal sealed class WebTransportStream
{
    public QuicStream Stream { get; }
    public ulong SessionId { get; }
    public bool Bidirectional { get; }
    public WebTransportSession? Session { get; internal set; }

    public delegate void DataHandler(WebTransportStream s, ReadOnlySpan<byte> data, bool fin);
    /// <summary>届いたバイト。fin は相手が送り終えた印。</summary>
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
            if (_pending.Count + data.Length > 1 << 20) { Stream.Abort(WebTransportSession.ErrorBufferedStreamRejected); return; }
            _pending.Append(data);
            _pendingFin |= fin;
            return;
        }
        if (OnData == null) return;
        OnData(this, data, fin);
    }

    internal void Flush()
    {
        if (_pending == null) return;
        var p = _pending;
        _pending = null;
        if (p.Count > 0 || _pendingFin) OnData?.Invoke(this, p.Data, _pendingFin);
    }

    public void Send(ReadOnlySpan<byte> data, bool fin = false) => Stream.Send(data, fin);
    public void Finish() => Stream.Finish();
    public void Abort(ulong code) => Stream.Abort(code);
}

/// <summary>試作の扱い手。stream と datagram をそのまま返す。</summary>
internal sealed class EchoHandler : IWebTransportHandler
{
    public bool Accept(WebTransportSession session) => session.Path.StartsWith("/wt", StringComparison.Ordinal);

    public void OnBidiStream(WebTransportSession session, WebTransportStream stream)
    {
        long total = 0;
        stream.OnData = (s, data, fin) =>
        {
            total += data.Length;
            if (!data.IsEmpty) s.Send(data);
            if (fin)
            {
                Program.Log($"セッション {session.Id} stream {s.Stream.Id}: {total} バイトを返した");
                s.Finish();
            }
        };
    }

    public void OnUniStream(WebTransportSession session, WebTransportStream stream)
    {
        // 単方向は全部受けてから、こちらの単方向 stream で返す
        var all = new RecvBuffer();
        stream.OnData = (s, data, fin) =>
        {
            all.Append(data);
            if (!fin) return;
            Program.Log($"セッション {session.Id} 単方向 stream {s.Stream.Id}: {all.Count} バイト");
            if (session.IsClosed) return;
            var back = session.OpenUni();
            back.Send(all.Data, fin: true);
        };
    }

    public void OnDatagram(WebTransportSession session, ReadOnlySpan<byte> data) => session.SendDatagram(data);
}
