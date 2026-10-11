namespace Mado.Tests;

public class RdCleanPathTests
{
    static byte[] Field(int n, byte[] v) => Der.Write(Der.Context(n), v);

    /// <summary>IronRDP が送ってくる形の要求(version / destination / proxy_auth / x224)</summary>
    static byte[] Request(byte[] x224) => Der.Write(Der.Sequence,
        Field(0, Der.WriteInteger(RdCleanPath.Version)),
        Field(2, Der.WriteUtf8("mado")),
        Field(3, Der.WriteUtf8("token")),
        Field(6, Der.WriteOctets(x224)));

    [Test]
    public async Task 要求を読む()
    {
        var x224 = Enumerable.Range(0, 19).Select(i => (byte)i).ToArray();
        var parsed = RdCleanPath.Parse(Request(x224));
        await Assert.That(parsed).IsNotNull();
        var (req, rest) = (parsed!.Value.Request, parsed.Value.Remaining);
        await Assert.That(req.Version).IsEqualTo(RdCleanPath.Version);
        await Assert.That(req.Destination).IsEqualTo("mado");
        await Assert.That(req.ProxyAuth).IsEqualTo("token");
        await Assert.That(req.X224!.SequenceEqual(x224)).IsTrue();
        await Assert.That(rest.Length).IsEqualTo(0);
    }

    [Test]
    public async Task 分かれて届いたら揃うまで_null()
    {
        var whole = Request(new byte[19]);
        for (var i = 0; i < whole.Length; i++)
            await Assert.That(RdCleanPath.Parse(whole.AsMemory(0, i))).IsNull();
        await Assert.That(RdCleanPath.Parse(whole)).IsNotNull();
    }

    [Test]
    public async Task 後ろに続きがあれば残す()
    {
        var parsed = RdCleanPath.Parse((byte[])[.. Request(new byte[3]), 9, 9]);
        await Assert.That(parsed!.Value.Remaining.ToArray().SequenceEqual(new byte[] { 9, 9 })).IsTrue();
    }

    [Test]
    public async Task 応答は長い証明書でも長形式で書く()
    {
        var output = RdCleanPath.Response(new byte[19], [new byte[1500]], "127.0.0.1:3389");
        var outer = Der.Read(output)!.Value;
        await Assert.That(outer.Tag).IsEqualTo(Der.Sequence);
        await Assert.That(outer.End).IsEqualTo(output.Length);
        var tags = Der.ReadAll(outer.Value).Select(t => t.Tag).ToArray();
        await Assert.That(tags.SequenceEqual(new[] { Der.Context(0), Der.Context(6), Der.Context(7), Der.Context(9) })).IsTrue();
    }

    [Test]
    public async Task エラーは_1_に入る()
    {
        var output = RdCleanPath.Error(RdCleanPath.GeneralError, 401);
        var tags = Der.ReadAll(Der.Read(output)!.Value.Value).Select(t => t.Tag).ToArray();
        await Assert.That(tags.SequenceEqual(new[] { Der.Context(0), Der.Context(1) })).IsTrue();
    }

    [Test]
    public async Task INTEGER_は最小の長さで先頭が_0x80_以上なら_0x00_を足す()
    {
        await Assert.That(Der.WriteInteger(RdCleanPath.Version).SequenceEqual(new byte[] { 0x02, 0x02, 0x0d, 0x3e })).IsTrue();
        await Assert.That(Der.WriteInteger(0x80).SequenceEqual(new byte[] { 0x02, 0x02, 0x00, 0x80 })).IsTrue();
        await Assert.That(Der.WriteInteger(0).SequenceEqual(new byte[] { 0x02, 0x01, 0x00 })).IsTrue();
    }

    [Test]
    public async Task TPKT_を_1_つ読む()
    {
        var cc = new byte[] { 3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 2, 0, 8, 0, 2, 0, 0, 0 };
        var read = await Relay.ReadTpkt(new MemoryStream([.. cc, 0xff]), CancellationToken.None);
        await Assert.That(read.SequenceEqual(cc)).IsTrue();
    }
}
