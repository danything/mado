namespace Mado.Tests;

public class SignerTests
{
    static Signer New() => Signer.Open(Directory.CreateTempSubdirectory("mado-signer-").FullName);

    [Test]
    public async Task 署名したものは読める()
    {
        var s = New();
        var t = s.Sign(new User("sub", "名前"), ApiJson.Default.User, 60);
        await Assert.That(s.Verify(t, ApiJson.Default.User)).IsEqualTo(new User("sub", "名前"));
    }

    [Test]
    public async Task 中身を変えたら通さない()
    {
        var s = New();
        var t = s.Sign(new User("sub", "a"), ApiJson.Default.User, 60);
        var forged = New().Sign(new User("admin", "a"), ApiJson.Default.User, 60);
        await Assert.That(s.Verify(forged.Split('.')[0] + "." + t.Split('.')[1], ApiJson.Default.User)).IsNull();
        await Assert.That(s.Verify("garbage", ApiJson.Default.User)).IsNull();
        await Assert.That(s.Verify(null, ApiJson.Default.User)).IsNull();
    }

    [Test]
    public async Task 期限が切れたら通さない()
    {
        var s = New();
        await Assert.That(s.Verify(s.Sign(new User("sub", "a"), ApiJson.Default.User, -1), ApiJson.Default.User)).IsNull();
    }

    [Test]
    public async Task 鍵はファイルに残り次の起動でも同じ()
    {
        var dir = Directory.CreateTempSubdirectory("mado-signer-").FullName;
        var t = Signer.Open(dir).Sign(new User("sub", "a"), ApiJson.Default.User, 60);
        await Assert.That(Signer.Open(dir).Verify(t, ApiJson.Default.User)).IsNotNull();
    }

    [Test]
    public async Task 戻る先は自分のところの絶対パスだけ()
    {
        await Assert.That(Oidc.SafeReturn("/a?b=c")).IsEqualTo("/a?b=c");
        await Assert.That(Oidc.SafeReturn("//evil.example")).IsEqualTo("/");
        await Assert.That(Oidc.SafeReturn("https://evil.example")).IsEqualTo("/");
        // ブラウザは \ を / として扱う
        await Assert.That(Oidc.SafeReturn("/\\evil.example")).IsEqualTo("/");
        await Assert.That(Oidc.SafeReturn("/a\\b")).IsEqualTo("/");
        await Assert.That(Oidc.SafeReturn(null)).IsEqualTo("/");
    }
}
