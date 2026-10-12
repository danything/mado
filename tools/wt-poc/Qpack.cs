// QPACK(RFC 9204)。動的表を使わない(SETTINGS_QPACK_MAX_TABLE_CAPACITY = 0)ので、静的表と文字列だけを扱う。
// 相手は動的表を参照できない。参照してきたら QPACK_DECOMPRESSION_FAILED にする。
using System.Text;

namespace Mado.WebTransport;

internal sealed class QpackException(string message) : Exception(message);

internal static class Qpack
{
    /// <summary>静的表(RFC 9204 付録 A)。番号は 0 から。</summary>
    public static readonly (string Name, string Value)[] StaticTable =
    [
        (":authority", ""),
        (":path", "/"),
        ("age", "0"),
        ("content-disposition", ""),
        ("content-length", "0"),
        ("cookie", ""),
        ("date", ""),
        ("etag", ""),
        ("if-modified-since", ""),
        ("if-none-match", ""),
        ("last-modified", ""),
        ("link", ""),
        ("location", ""),
        ("referer", ""),
        ("set-cookie", ""),
        (":method", "CONNECT"),
        (":method", "DELETE"),
        (":method", "GET"),
        (":method", "HEAD"),
        (":method", "OPTIONS"),
        (":method", "POST"),
        (":method", "PUT"),
        (":scheme", "http"),
        (":scheme", "https"),
        (":status", "103"),
        (":status", "200"),
        (":status", "304"),
        (":status", "404"),
        (":status", "503"),
        ("accept", "*/*"),
        ("accept", "application/dns-message"),
        ("accept-encoding", "gzip, deflate, br"),
        ("accept-ranges", "bytes"),
        ("access-control-allow-headers", "cache-control"),
        ("access-control-allow-headers", "content-type"),
        ("access-control-allow-origin", "*"),
        ("cache-control", "max-age=0"),
        ("cache-control", "max-age=2592000"),
        ("cache-control", "max-age=604800"),
        ("cache-control", "no-cache"),
        ("cache-control", "no-store"),
        ("cache-control", "public, max-age=31536000"),
        ("content-encoding", "br"),
        ("content-encoding", "gzip"),
        ("content-type", "application/dns-message"),
        ("content-type", "application/javascript"),
        ("content-type", "application/json"),
        ("content-type", "application/x-www-form-urlencoded"),
        ("content-type", "image/gif"),
        ("content-type", "image/jpeg"),
        ("content-type", "image/png"),
        ("content-type", "text/css"),
        ("content-type", "text/html; charset=utf-8"),
        ("content-type", "text/plain"),
        ("content-type", "text/plain;charset=utf-8"),
        ("range", "bytes=0-"),
        ("strict-transport-security", "max-age=31536000"),
        ("strict-transport-security", "max-age=31536000; includesubdomains"),
        ("strict-transport-security", "max-age=31536000; includesubdomains; preload"),
        ("vary", "accept-encoding"),
        ("vary", "origin"),
        ("x-content-type-options", "nosniff"),
        ("x-xss-protection", "1; mode=block"),
        (":status", "100"),
        (":status", "204"),
        (":status", "206"),
        (":status", "302"),
        (":status", "400"),
        (":status", "403"),
        (":status", "421"),
        (":status", "425"),
        (":status", "500"),
        ("accept-language", ""),
        ("access-control-allow-credentials", "FALSE"),
        ("access-control-allow-credentials", "TRUE"),
        ("access-control-allow-headers", "*"),
        ("access-control-allow-methods", "get"),
        ("access-control-allow-methods", "get, post, options"),
        ("access-control-allow-methods", "options"),
        ("access-control-expose-headers", "content-length"),
        ("access-control-request-headers", "content-type"),
        ("access-control-request-method", "get"),
        ("access-control-request-method", "post"),
        ("alt-svc", "clear"),
        ("authorization", ""),
        ("content-security-policy", "script-src 'none'; object-src 'none'; base-uri 'none'"),
        ("early-data", "1"),
        ("expect-ct", ""),
        ("forwarded", ""),
        ("if-range", ""),
        ("origin", ""),
        ("purpose", "prefetch"),
        ("server", ""),
        ("timing-allow-origin", "*"),
        ("upgrade-insecure-requests", "1"),
        ("user-agent", ""),
        ("x-forwarded-for", ""),
        ("x-frame-options", "deny"),
        ("x-frame-options", "sameorigin"),
    ];

    /// <summary>
    /// 前置きの整数(RFC 7541 5.1)。先頭バイトの下 prefixBits bit から始まり、全部 1 なら続きのバイトに 7 bit ずつ入る。
    /// </summary>
    public static ulong ReadInt(ReadOnlySpan<byte> s, ref int pos, int prefixBits)
    {
        if (pos >= s.Length) throw new QpackException("整数が途中で切れた");
        ulong max = (1UL << prefixBits) - 1;
        ulong v = (ulong)s[pos++] & max;
        if (v < max) return v;
        int shift = 0;
        while (true)
        {
            if (pos >= s.Length) throw new QpackException("整数が途中で切れた");
            byte b = s[pos++];
            if (shift > 56) throw new QpackException("整数が大きすぎる");
            v += (ulong)(b & 0x7f) << shift;
            shift += 7;
            if ((b & 0x80) == 0) return v;
        }
    }

    public static void WriteInt(ByteWriter w, byte firstBits, int prefixBits, ulong v)
    {
        ulong max = (1UL << prefixBits) - 1;
        if (v < max) { w.Byte((byte)(firstBits | (byte)v)); return; }
        w.Byte((byte)(firstBits | (byte)max));
        v -= max;
        while (v >= 0x80) { w.Byte((byte)(0x80 | (v & 0x7f))); v >>= 7; }
        w.Byte((byte)v);
    }

    /// <summary>文字列。先頭バイトの huffmanBit が立っていれば Huffman 符号。長さは prefixBits の前置き整数。</summary>
    static string ReadString(ReadOnlySpan<byte> s, ref int pos, int prefixBits)
    {
        if (pos >= s.Length) throw new QpackException("文字列が途中で切れた");
        bool huffman = (s[pos] & (1 << prefixBits)) != 0;
        ulong len = ReadInt(s, ref pos, prefixBits);
        if (len > (ulong)(s.Length - pos)) throw new QpackException("文字列が途中で切れた");
        var raw = s.Slice(pos, (int)len);
        pos += (int)len;
        // ヘッダーの値は ISO-8859-1 として扱う(バイトをそのまま文字に)
        return huffman ? Latin1(Huffman.Decode(raw)) : Latin1(raw);
    }

    static string Latin1(ReadOnlySpan<byte> b) => Encoding.Latin1.GetString(b);

    /// <summary>HEADERS フレームの中身(field section)を読む。</summary>
    public static List<(string Name, string Value)> Decode(ReadOnlySpan<byte> block)
    {
        int pos = 0;
        // Required Insert Count と Base。動的表が無いので Required Insert Count は 0 でなければならない
        ulong ric = ReadInt(block, ref pos, 8);
        if (ric != 0) throw new QpackException("動的表を参照している");
        ReadInt(block, ref pos, 7); // S と Delta Base。動的表が無いので使わない

        var list = new List<(string, string)>();
        while (pos < block.Length)
        {
            byte b = block[pos];
            if ((b & 0x80) != 0)
            {
                // 1T: 表の行をそのまま使う
                bool isStatic = (b & 0x40) != 0;
                ulong idx = ReadInt(block, ref pos, 6);
                if (!isStatic) throw new QpackException("動的表を参照している");
                list.Add(Static(idx));
            }
            else if ((b & 0x40) != 0)
            {
                // 01NT: 名前は表から、値は文字列
                bool isStatic = (b & 0x10) != 0;
                ulong idx = ReadInt(block, ref pos, 4);
                if (!isStatic) throw new QpackException("動的表を参照している");
                string value = ReadString(block, ref pos, 7);
                list.Add((Static(idx).Name, value));
            }
            else if ((b & 0x20) != 0)
            {
                // 001N: 名前も値も文字列。名前の長さは 3 bit の前置き、その上の bit が Huffman
                string name = ReadString(block, ref pos, 3);
                string value = ReadString(block, ref pos, 7);
                list.Add((name, value));
            }
            else
            {
                // 0001 / 0000: Base より後ろの動的表の参照
                throw new QpackException("動的表を参照している");
            }
        }
        return list;
    }

    static (string Name, string Value) Static(ulong idx)
    {
        if (idx >= (ulong)StaticTable.Length) throw new QpackException($"静的表に無い番号 {idx}");
        return StaticTable[idx];
    }

    /// <summary>
    /// field section を作る。静的表に名前と値が両方あればその番号、名前だけあれば名前の番号と値の文字列、
    /// どちらも無ければ両方を文字列で書く。Huffman は使わない。
    /// </summary>
    public static byte[] Encode(IEnumerable<(string Name, string Value)> fields)
    {
        var w = new ByteWriter();
        w.Byte(0).Byte(0); // Required Insert Count = 0, Base = 0
        foreach (var (name, value) in fields)
        {
            int full = -1, nameOnly = -1;
            for (int i = 0; i < StaticTable.Length; i++)
            {
                if (StaticTable[i].Name != name) continue;
                if (nameOnly < 0) nameOnly = i;
                if (StaticTable[i].Value == value) { full = i; break; }
            }
            var v = Encoding.Latin1.GetBytes(value);
            if (full >= 0)
            {
                WriteInt(w, 0xc0, 6, (ulong)full);
            }
            else if (nameOnly >= 0)
            {
                WriteInt(w, 0x50, 4, (ulong)nameOnly);
                WriteInt(w, 0x00, 7, (ulong)v.Length);
                w.Bytes(v);
            }
            else
            {
                var n = Encoding.Latin1.GetBytes(name);
                WriteInt(w, 0x20, 3, (ulong)n.Length);
                w.Bytes(n);
                WriteInt(w, 0x00, 7, (ulong)v.Length);
                w.Bytes(v);
            }
        }
        return w.ToArray();
    }
}

/// <summary>
/// HPACK の Huffman 符号(RFC 7541 付録 B)の復号。QPACK も同じ表を使う。
/// 1 bit ずつ読み、(長さ, 符号) の表で文字を引く。ヘッダーは短いのでこれで足りる。
/// </summary>
internal static class Huffman
{
    // 記号 0〜255 と EOS(256)の符号。RFC 7541 付録 B の表から写した
    static readonly uint[] Codes =
    [
        0x1ff8,0x7fffd8,0xfffffe2,0xfffffe3,0xfffffe4,0xfffffe5,0xfffffe6,0xfffffe7,0xfffffe8,0xffffea,0x3ffffffc,0xfffffe9,0xfffffea,0x3ffffffd,0xfffffeb,0xfffffec,
        0xfffffed,0xfffffee,0xfffffef,0xffffff0,0xffffff1,0xffffff2,0x3ffffffe,0xffffff3,0xffffff4,0xffffff5,0xffffff6,0xffffff7,0xffffff8,0xffffff9,0xffffffa,0xffffffb,
        0x14,0x3f8,0x3f9,0xffa,0x1ff9,0x15,0xf8,0x7fa,0x3fa,0x3fb,0xf9,0x7fb,0xfa,0x16,0x17,0x18,
        0x0,0x1,0x2,0x19,0x1a,0x1b,0x1c,0x1d,0x1e,0x1f,0x5c,0xfb,0x7ffc,0x20,0xffb,0x3fc,
        0x1ffa,0x21,0x5d,0x5e,0x5f,0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,
        0x6b,0x6c,0x6d,0x6e,0x6f,0x70,0x71,0x72,0xfc,0x73,0xfd,0x1ffb,0x7fff0,0x1ffc,0x3ffc,0x22,
        0x7ffd,0x3,0x23,0x4,0x24,0x5,0x25,0x26,0x27,0x6,0x74,0x75,0x28,0x29,0x2a,0x7,
        0x2b,0x76,0x2c,0x8,0x9,0x2d,0x77,0x78,0x79,0x7a,0x7b,0x7ffe,0x7fc,0x3ffd,0x1ffd,0xffffffc,
        0xfffe6,0x3fffd2,0xfffe7,0xfffe8,0x3fffd3,0x3fffd4,0x3fffd5,0x7fffd9,0x3fffd6,0x7fffda,0x7fffdb,0x7fffdc,0x7fffdd,0x7fffde,0xffffeb,0x7fffdf,
        0xffffec,0xffffed,0x3fffd7,0x7fffe0,0xffffee,0x7fffe1,0x7fffe2,0x7fffe3,0x7fffe4,0x1fffdc,0x3fffd8,0x7fffe5,0x3fffd9,0x7fffe6,0x7fffe7,0xffffef,
        0x3fffda,0x1fffdd,0xfffe9,0x3fffdb,0x3fffdc,0x7fffe8,0x7fffe9,0x1fffde,0x7fffea,0x3fffdd,0x3fffde,0xfffff0,0x1fffdf,0x3fffdf,0x7fffeb,0x7fffec,
        0x1fffe0,0x1fffe1,0x3fffe0,0x1fffe2,0x7fffed,0x3fffe1,0x7fffee,0x7fffef,0xfffea,0x3fffe2,0x3fffe3,0x3fffe4,0x7ffff0,0x3fffe5,0x3fffe6,0x7ffff1,
        0x3ffffe0,0x3ffffe1,0xfffeb,0x7fff1,0x3fffe7,0x7ffff2,0x3fffe8,0x1ffffec,0x3ffffe2,0x3ffffe3,0x3ffffe4,0x7ffffde,0x7ffffdf,0x3ffffe5,0xfffff1,0x1ffffed,
        0x7fff2,0x1fffe3,0x3ffffe6,0x7ffffe0,0x7ffffe1,0x3ffffe7,0x7ffffe2,0xfffff2,0x1fffe4,0x1fffe5,0x3ffffe8,0x3ffffe9,0xffffffd,0x7ffffe3,0x7ffffe4,0x7ffffe5,
        0xfffec,0xfffff3,0xfffed,0x1fffe6,0x3fffe9,0x1fffe7,0x1fffe8,0x7ffff3,0x3fffea,0x3fffeb,0x1ffffee,0x1ffffef,0xfffff4,0xfffff5,0x3ffffea,0x7ffff4,
        0x3ffffeb,0x7ffffe6,0x3ffffec,0x3ffffed,0x7ffffe7,0x7ffffe8,0x7ffffe9,0x7ffffea,0x7ffffeb,0xffffffe,0x7ffffec,0x7ffffed,0x7ffffee,0x7ffffef,0x7fffff0,0x3ffffee,
        0x3fffffff,
    ];

    static readonly byte[] Lengths =
    [
        13,23,28,28,28,28,28,28,28,24,30,28,28,30,28,28,28,28,28,28,28,28,30,28,28,28,28,28,28,28,28,28,
        6,10,10,12,13,6,8,11,10,10,8,11,8,6,6,6,5,5,5,6,6,6,6,6,6,6,7,8,15,6,12,10,
        13,6,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,7,8,13,19,13,14,6,
        15,5,6,5,6,5,6,6,6,5,7,7,6,6,6,5,6,7,6,5,5,6,7,7,7,7,7,15,11,14,13,28,
        20,22,20,20,22,22,22,23,22,23,23,23,23,23,24,23,24,24,22,23,24,23,23,23,23,21,22,23,22,23,23,24,
        22,21,20,22,22,23,23,21,23,22,22,24,21,22,23,23,21,21,22,21,23,22,23,23,20,22,22,22,23,22,22,23,
        26,26,20,19,22,23,22,25,26,26,26,27,27,26,24,25,19,21,26,27,27,26,27,24,21,21,26,26,28,27,27,27,
        20,24,20,21,22,21,21,23,22,22,25,25,24,24,26,23,26,27,26,26,27,27,27,27,27,28,27,27,27,27,27,26,
        30,
    ];

    // (長さ << 32 | 符号) → 記号
    static readonly Dictionary<ulong, int> Table = Build();

    static Dictionary<ulong, int> Build()
    {
        if (Codes.Length != 257 || Lengths.Length != 257) throw new InvalidOperationException("Huffman の表の長さが違う");
        var d = new Dictionary<ulong, int>(257);
        for (int i = 0; i < 257; i++) d.Add(((ulong)Lengths[i] << 32) | Codes[i], i);
        return d;
    }

    public static byte[] Decode(ReadOnlySpan<byte> src)
    {
        var out_ = new List<byte>(src.Length * 8 / 5);
        uint code = 0;
        int len = 0;
        foreach (byte b in src)
        {
            for (int bit = 7; bit >= 0; bit--)
            {
                code = (code << 1) | (uint)((b >> bit) & 1);
                len++;
                if (len < 5) continue;
                if (Table.TryGetValue(((ulong)len << 32) | code, out var sym))
                {
                    if (sym == 256) throw new QpackException("Huffman に EOS が入っている");
                    out_.Add((byte)sym);
                    code = 0;
                    len = 0;
                }
                else if (len >= 30)
                {
                    throw new QpackException("Huffman の符号が不正");
                }
            }
        }
        // 余りは 7 bit 以下で、EOS の頭(全部 1)でなければならない
        if (len > 7 || code != (1u << len) - 1) throw new QpackException("Huffman の詰め物が不正");
        return out_.ToArray();
    }

    /// <summary>試験用の符号化。</summary>
    public static byte[] Encode(ReadOnlySpan<byte> src)
    {
        var w = new List<byte>();
        ulong acc = 0;
        int bits = 0;
        foreach (byte b in src)
        {
            acc = (acc << Lengths[b]) | Codes[b];
            bits += Lengths[b];
            while (bits >= 8) { bits -= 8; w.Add((byte)(acc >> bits)); }
        }
        if (bits > 0) w.Add((byte)((acc << (8 - bits)) | (0xffu >> bits)));
        return w.ToArray();
    }
}
