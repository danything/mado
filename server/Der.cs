namespace Mado;

/// <summary>
/// RDCleanPath に要るだけの DER(ASN.1)の読み書き。長さは長形式まで読む(サーバー証明書の連なりは 127 バイトを超える)。
/// System.Formats.Asn1 もあるが、RDCleanPath の「全部 EXPLICIT の文脈タグ」を素直に書くにはこちらのほうが短い。
/// </summary>
internal static class Der
{
    public const byte Integer = 0x02;
    public const byte OctetString = 0x04;
    public const byte Utf8String = 0x0c;
    public const byte Sequence = 0x30;

    /// <summary>[n] EXPLICIT(構造化・文脈タグ)</summary>
    public static byte Context(int n) => (byte)(0xa0 | n);

    public readonly record struct Tlv(byte Tag, ReadOnlyMemory<byte> Value, int End);

    /// <summary>buf[at] から 1 つ読む。足りなければ null(続きを待つ)</summary>
    public static Tlv? Read(ReadOnlyMemory<byte> buf, int at = 0)
    {
        var s = buf.Span;
        if (s.Length < at + 2) return null;
        var tag = s[at];
        var len = (int)s[at + 1];
        var head = 2;
        if ((len & 0x80) != 0)
        {
            var n = len & 0x7f;
            if (n == 0 || n > 4) throw new FormatException($"DER: unsupported length form ({n})");
            if (s.Length < at + 2 + n) return null;
            len = 0;
            for (var i = 0; i < n; i++) len = len * 256 + s[at + 2 + i];
            head += n;
        }
        var start = at + head;
        if (s.Length < start + len) return null;
        return new Tlv(tag, buf.Slice(start, len), start + len);
    }

    /// <summary>中身を順に全部読む(SEQUENCE や文脈タグの中)</summary>
    public static List<Tlv> ReadAll(ReadOnlyMemory<byte> buf)
    {
        var list = new List<Tlv>();
        var at = 0;
        while (at < buf.Length)
        {
            var t = Read(buf, at) ?? throw new FormatException("DER: truncated");
            list.Add(t);
            at = t.End;
        }
        return list;
    }

    public static byte[] Write(byte tag, params byte[][] parts)
    {
        var len = parts.Sum(p => p.Length);
        var head = new List<byte> { tag };
        if (len < 0x80) head.Add((byte)len);
        else
        {
            var b = new List<byte>();
            for (var v = len; v > 0; v >>= 8) b.Insert(0, (byte)(v & 0xff));
            head.Add((byte)(0x80 | b.Count));
            head.AddRange(b);
        }
        return [.. head, .. parts.SelectMany(p => p)];
    }

    /// <summary>0 以上の整数(2 の補数で最小の長さ。先頭が 0x80 以上なら 0x00 を足す)</summary>
    public static byte[] WriteInteger(ulong n)
    {
        var b = new List<byte>();
        do
        {
            b.Insert(0, (byte)(n & 0xff));
            n >>= 8;
        } while (n > 0);
        if ((b[0] & 0x80) != 0) b.Insert(0, 0);
        return Write(Integer, [.. b]);
    }

    public static ulong ReadInteger(Tlv t)
    {
        if (t.Tag != Integer) throw new FormatException($"DER: expected INTEGER, got 0x{t.Tag:x2}");
        ulong v = 0;
        foreach (var x in t.Value.Span) v = (v << 8) | x;
        return v;
    }

    public static byte[] WriteUtf8(string s) => Write(Utf8String, System.Text.Encoding.UTF8.GetBytes(s));

    public static string ReadUtf8(Tlv t)
    {
        if (t.Tag != Utf8String) throw new FormatException($"DER: expected UTF8String, got 0x{t.Tag:x2}");
        return System.Text.Encoding.UTF8.GetString(t.Value.Span);
    }

    public static byte[] WriteOctets(byte[] b) => Write(OctetString, b);

    public static byte[] ReadOctets(Tlv t)
    {
        if (t.Tag != OctetString) throw new FormatException($"DER: expected OCTET STRING, got 0x{t.Tag:x2}");
        return t.Value.ToArray();
    }
}
