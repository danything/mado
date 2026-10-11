namespace Mado;

/// <summary>
/// RDCleanPath の PDU(Devolutions の IronRDP の crates/ironrdp-rdcleanpath と同じ形)。
///
/// ブラウザは RDP の TLS を自分で張れない。そこでブラウザは最初に RDCleanPath の要求(X.224 の接続要求入り)を送り、
/// ゲートウェイが RDP サーバーと X.224 → TLS までを代わりにやって、サーバーの応答(X.224 の接続確認)と証明書の連なりを
/// 返す。そのあとは平文の RDP をゲートウェイが TLS に包んで流す。証明書を返すのは、ブラウザ側の CredSSP がサーバーの
/// 公開鍵に結びつけた認証をするため。
///
///   RDCleanPathPdu ::= SEQUENCE {            -- 文脈タグはすべて EXPLICIT
///     version [0] INTEGER (3390), error [1] RDCleanPathErr OPTIONAL, destination [2] UTF8String OPTIONAL,
///     proxy_auth [3] UTF8String OPTIONAL, server_auth [4] UTF8String OPTIONAL,
///     preconnection_blob [5] UTF8String OPTIONAL, x224_connection_pdu [6] OCTET STRING OPTIONAL,
///     server_cert_chain [7] SEQUENCE OF OCTET STRING OPTIONAL, server_addr [9] UTF8String OPTIONAL }
///   RDCleanPathErr ::= SEQUENCE { error_code [0] INTEGER, http_status_code [1] INTEGER OPTIONAL,
///     wsa_last_error [2] INTEGER OPTIONAL, tls_alert_code [3] INTEGER OPTIONAL }
/// </summary>
internal static class RdCleanPath
{
    public const ulong Version = 3390;
    public const ulong GeneralError = 1;
    public const ulong NegotiationError = 2;

    public sealed record Request(
        ulong Version,
        string? Destination,
        string? ProxyAuth,
        string? PreconnectionBlob,
        byte[]? X224);

    /// <summary>届いたぶんで PDU が揃っていれば読む。揃っていなければ null(続きを待つ)。rest は後ろに続いていたもの</summary>
    public static (Request Request, ReadOnlyMemory<byte> Remaining)? Parse(ReadOnlyMemory<byte> buf)
    {
        var outer = Der.Read(buf);
        if (outer is null) return null;
        if (outer.Value.Tag != Der.Sequence) throw new FormatException("RDCleanPath: not a SEQUENCE");
        ulong version = 0;
        string? destination = null, proxyAuth = null, pcb = null;
        byte[]? x224 = null;
        foreach (var field in Der.ReadAll(outer.Value.Value))
        {
            var inner = Der.Read(field.Value) ?? throw new FormatException("RDCleanPath: empty field");
            if (field.Tag == Der.Context(0)) version = Der.ReadInteger(inner);
            else if (field.Tag == Der.Context(2)) destination = Der.ReadUtf8(inner);
            else if (field.Tag == Der.Context(3)) proxyAuth = Der.ReadUtf8(inner);
            else if (field.Tag == Der.Context(5)) pcb = Der.ReadUtf8(inner);
            else if (field.Tag == Der.Context(6)) x224 = Der.ReadOctets(inner);
            // server_auth [4] などは使わない
        }
        return (new Request(version, destination, proxyAuth, pcb, x224), buf[outer.Value.End..]);
    }

    static byte[] Field(int n, byte[] value) => Der.Write(Der.Context(n), value);

    public static byte[] Response(byte[] x224, IEnumerable<byte[]> certChain, string serverAddr) =>
        Der.Write(Der.Sequence,
            Field(0, Der.WriteInteger(Version)),
            Field(6, Der.WriteOctets(x224)),
            Field(7, Der.Write(Der.Sequence, [.. certChain.Select(Der.WriteOctets)])),
            Field(9, Der.WriteUtf8(serverAddr)));

    public static byte[] Error(ulong code, ulong? httpStatus = null, byte[]? x224 = null)
    {
        var e = new List<byte[]> { Field(0, Der.WriteInteger(code)) };
        if (httpStatus is { } h) e.Add(Field(1, Der.WriteInteger(h)));
        var parts = new List<byte[]>
        {
            Field(0, Der.WriteInteger(Version)),
            Field(1, Der.Write(Der.Sequence, [.. e])),
        };
        if (x224 is not null) parts.Add(Field(6, Der.WriteOctets(x224)));
        return Der.Write(Der.Sequence, [.. parts]);
    }
}
