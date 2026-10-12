// HTTP/3(RFC 9114)の部品。可変長整数、フレーム、SETTINGS、受信の溜め置き。
// QUIC の上の HTTP/3 は stream ごとにフレームを並べる。フレームは「型、長さ、中身」で、型と長さは可変長整数。
namespace Mado.Quic;

/// <summary>QUIC の可変長整数(RFC 9000 16 節)。先頭 2 bit が長さ(1, 2, 4, 8 バイト)。</summary>
internal static class VarInt
{
    public const ulong Max = (1UL << 62) - 1;

    /// <summary>読めたら値と使ったバイト数を返す。足りなければ false。</summary>
    public static bool TryRead(ReadOnlySpan<byte> s, out ulong value, out int length)
    {
        value = 0;
        length = 0;
        if (s.IsEmpty) return false;
        length = 1 << (s[0] >> 6);
        if (s.Length < length) { length = 0; return false; }
        value = (ulong)(s[0] & 0x3f);
        for (int i = 1; i < length; i++) value = (value << 8) | s[i];
        return true;
    }

    public static int Size(ulong v) => v < 64 ? 1 : v < 16384 ? 2 : v < (1UL << 30) ? 4 : 8;

    public static int Write(Span<byte> d, ulong v)
    {
        int n = Size(v);
        for (int i = n - 1; i >= 0; i--) { d[i] = (byte)v; v >>= 8; }
        d[0] |= n switch { 1 => 0x00, 2 => 0x40, 4 => 0x80, _ => 0xc0 };
        return n;
    }
}

/// <summary>書き出し用の小さな器。</summary>
internal sealed class ByteWriter
{
    byte[] _buf = new byte[64];
    public int Length { get; private set; }

    void Ensure(int n)
    {
        if (Length + n <= _buf.Length) return;
        Array.Resize(ref _buf, Math.Max(_buf.Length * 2, Length + n));
    }

    public ByteWriter VarInt(ulong v)
    {
        Ensure(8);
        Length += Quic.VarInt.Write(_buf.AsSpan(Length), v);
        return this;
    }

    public ByteWriter Byte(byte b)
    {
        Ensure(1);
        _buf[Length++] = b;
        return this;
    }

    public ByteWriter Bytes(ReadOnlySpan<byte> b)
    {
        Ensure(b.Length);
        b.CopyTo(_buf.AsSpan(Length));
        Length += b.Length;
        return this;
    }

    public ByteWriter UInt32BE(uint v)
    {
        Ensure(4);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(_buf.AsSpan(Length), v);
        Length += 4;
        return this;
    }

    public ReadOnlySpan<byte> Span => _buf.AsSpan(0, Length);
    public byte[] ToArray() => _buf.AsSpan(0, Length).ToArray();
}

/// <summary>stream の受信を溜めて、頭から読んで捨てる。</summary>
internal sealed class RecvBuffer
{
    byte[] _buf = new byte[256];
    int _start;
    int _end;

    public ReadOnlySpan<byte> Data => _buf.AsSpan(_start, _end - _start);
    public int Count => _end - _start;

    public void Append(ReadOnlySpan<byte> data)
    {
        if (_end + data.Length > _buf.Length)
        {
            int live = _end - _start;
            if (live + data.Length <= _buf.Length)
            {
                _buf.AsSpan(_start, live).CopyTo(_buf);
            }
            else
            {
                var n = new byte[Math.Max(_buf.Length * 2, live + data.Length)];
                _buf.AsSpan(_start, live).CopyTo(n);
                _buf = n;
            }
            _start = 0;
            _end = live;
        }
        data.CopyTo(_buf.AsSpan(_end));
        _end += data.Length;
    }

    public void Consume(int n)
    {
        _start += n;
        if (_start == _end) _start = _end = 0;
    }
}

/// <summary>HTTP/3 の定数。WebTransport の値は Chromium(quiche)の http_constants.h に合わせる。</summary>
internal static class H3
{
    // stream の型(単方向 stream の先頭の可変長整数)
    public const ulong StreamControl = 0x00;
    public const ulong StreamPush = 0x01;
    public const ulong StreamQpackEncoder = 0x02;
    public const ulong StreamQpackDecoder = 0x03;
    public const ulong StreamWebTransportUni = 0x54;

    // 双方向の WebTransport stream の先頭。フレームの型の場所に置く(長さは付かない)
    public const ulong WebTransportBidiSignal = 0x41;

    // フレームの型
    public const ulong FrameData = 0x00;
    public const ulong FrameHeaders = 0x01;
    public const ulong FrameCancelPush = 0x03;
    public const ulong FrameSettings = 0x04;
    public const ulong FramePushPromise = 0x05;
    public const ulong FrameGoAway = 0x07;
    public const ulong FrameMaxPushId = 0x0d;

    // SETTINGS の識別子
    public const ulong SettingQpackMaxTableCapacity = 0x01;
    public const ulong SettingMaxFieldSectionSize = 0x06;
    public const ulong SettingQpackBlockedStreams = 0x07;
    public const ulong SettingEnableConnectProtocol = 0x08;   // RFC 9220
    public const ulong SettingH3Datagram = 0x33;              // RFC 9297
    public const ulong SettingH3DatagramDraft04 = 0xffd277;
    public const ulong SettingEnableWebTransportDraft02 = 0x2b603742;
    public const ulong SettingWebTransportMaxSessionsDraft07 = 0xc671706a;
    public const ulong SettingWtMaxSessions = 0x14e9cd29;     // draft-09 以降。Chrome はまだ読まない

    // 誤りの番号(RFC 9114 8.1)
    public const ulong NoError = 0x100;
    public const ulong GeneralProtocolError = 0x101;
    public const ulong InternalError = 0x102;
    public const ulong StreamCreationError = 0x103;
    public const ulong ClosedCriticalStream = 0x104;
    public const ulong FrameUnexpected = 0x105;
    public const ulong FrameError = 0x106;
    public const ulong ExcessiveLoad = 0x107;
    public const ulong SettingsError = 0x109;
    public const ulong MissingSettings = 0x10a;
    public const ulong RequestRejected = 0x10b;
    public const ulong RequestCancelled = 0x10c;
    public const ulong RequestIncomplete = 0x10d;
    public const ulong MessageError = 0x10e;
    public const ulong QpackDecompressionFailed = 0x200;
    public const ulong DatagramError = 0x33;

    // HTTP/2 にあって HTTP/3 で禁じた型(RFC 9114 7.2.8)。届いたら接続の誤り
    public static bool IsHttp2Only(ulong type) => type is 0x02 or 0x06 or 0x08 or 0x09;

    /// <summary>フレームを 1 つ組み立てる。</summary>
    public static byte[] Frame(ulong type, ReadOnlySpan<byte> payload)
    {
        var w = new ByteWriter();
        w.VarInt(type).VarInt((ulong)payload.Length).Bytes(payload);
        return w.ToArray();
    }

    /// <summary>SETTINGS の中身(識別子と値の組の並び)。</summary>
    public static byte[] Settings(IEnumerable<(ulong Id, ulong Value)> settings)
    {
        var p = new ByteWriter();
        foreach (var (id, v) in settings) p.VarInt(id).VarInt(v);
        return Frame(FrameSettings, p.Span);
    }

    /// <summary>SETTINGS の中身を読む。同じ識別子が 2 度来たら誤り。</summary>
    public static Dictionary<ulong, ulong>? ParseSettings(ReadOnlySpan<byte> payload)
    {
        var d = new Dictionary<ulong, ulong>();
        while (!payload.IsEmpty)
        {
            if (!VarInt.TryRead(payload, out var id, out var n1)) return null;
            payload = payload[n1..];
            if (!VarInt.TryRead(payload, out var v, out var n2)) return null;
            payload = payload[n2..];
            if (!d.TryAdd(id, v)) return null;
        }
        return d;
    }

    /// <summary>
    /// 溜めた受信からフレームを 1 つ切り出す。まだ足りなければ false。
    /// 中身が maxPayload を超えるときは tooLarge を立てる(受け取りを断るため)。
    /// </summary>
    public static bool TryReadFrame(ReadOnlySpan<byte> buf, ulong maxPayload, out ulong type, out int headerLength, out int payloadLength, out bool tooLarge)
    {
        type = 0; headerLength = 0; payloadLength = 0; tooLarge = false;
        if (!VarInt.TryRead(buf, out type, out var n1)) return false;
        if (!VarInt.TryRead(buf[n1..], out var len, out var n2)) return false;
        if (len > maxPayload) { tooLarge = true; return false; }
        headerLength = n1 + n2;
        payloadLength = (int)len;
        return buf.Length >= headerLength + payloadLength;
    }

    /// <summary>GREASE の値(0x1f * N + 0x21)。読み飛ばす。</summary>
    public static bool IsGrease(ulong v) => v >= 0x21 && (v - 0x21) % 0x1f == 0;
}
