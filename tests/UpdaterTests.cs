using System.Security.Cryptography;
using System.Text;

namespace Mado.Tests;

public class UpdaterTests
{
    static (string Pub, Func<string, string> Sign) NewKey()
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()),
            m => Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(m), HashAlgorithmName.SHA256)));
    }

    [Test]
    public async Task 署名を確かめる()
    {
        var (pub, sign) = NewKey();
        var m = Updater.Message("v1.2.3", new string('a', 64));
        await Assert.That(Updater.Verify(m, sign(m), pub)).IsTrue();
    }

    [Test]
    public async Task タグや中身が違えば通さない()
    {
        var (pub, sign) = NewKey();
        var sig = sign(Updater.Message("v0.4.0", new string('a', 64)));
        await Assert.That(Updater.Verify(Updater.Message("v9.9.9", new string('a', 64)), sig, pub)).IsFalse();
        await Assert.That(Updater.Verify(Updater.Message("v0.4.0", new string('b', 64)), sig, pub)).IsFalse();
    }

    [Test]
    public async Task 別の鍵や壊れた署名は通さない()
    {
        var (_, sign) = NewKey();
        var m = Updater.Message("v1.0.0", new string('0', 64));
        await Assert.That(Updater.Verify(m, sign(m))).IsFalse();
        await Assert.That(Updater.Verify(m, "not base64!")).IsFalse();
    }

    [Test]
    public async Task 埋め込んだ公開鍵は_P256_として読める()
    {
        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(Updater.PublicKey), out _);
        await Assert.That(key.KeySize).IsEqualTo(256);
    }

    [Test]
    public async Task 版の比較()
    {
        await Assert.That(Updater.Compare("v0.5.0", "v0.4.9")).IsGreaterThan(0);
        await Assert.That(Updater.Compare("v0.10.0", "v0.9.0")).IsGreaterThan(0);
        await Assert.That(Updater.Compare("0.4.0", "v0.4.0")).IsEqualTo(0);
        await Assert.That(Updater.Compare("v0.4.0", "v1.0.0")).IsLessThan(0);
    }

    // --- 落として確かめて入れる(HttpMessageHandler を差し替え、msiexec の代わりに記録する) ---------------

    sealed class FakeGitHub(string tag, byte[] msi, Func<string> sig) : HttpMessageHandler
    {
        public int MsiDownloads;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            var u = req.RequestUri!.ToString();
            HttpContent body;
            if (u.EndsWith("/releases/latest"))
                body = new StringContent($$"""{"tag_name":"{{tag}}","assets":[{"name":"mado.msi","browser_download_url":"https://dl.test/msi"},{"name":"mado.msi.sig","browser_download_url":"https://dl.test/sig"}]}""");
            else if (u.EndsWith("/msi")) { MsiDownloads++; body = new ByteArrayContent(msi); }
            else if (u.EndsWith("/sig")) body = new StringContent(sig());
            else return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NotFound));
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = body });
        }
    }

    static (Updater Updater, FakeGitHub GitHub, List<string> Launched, string Dir) Setup(bool goodSig)
    {
        var (pub, sign) = NewKey();
        var msi = "MSI"u8.ToArray();
        var sha = Convert.ToHexStringLower(SHA256.HashData(msi));
        var gh = new FakeGitHub("v9.0.0", msi, () => sign(Updater.Message(goodSig ? "v9.0.0" : "v8.0.0", sha)));
        var dir = Path.Combine(Directory.CreateTempSubdirectory("mado-update-").FullName, "data");
        var launched = new List<string>();
        var u = new Updater("x/y", "v0.5.0", dir, Path.Combine(Path.GetDirectoryName(dir)!, "logs"), new HttpClient(gh), _ => { }, (msiPath, _) => launched.Add(msiPath), pub);
        return (u, gh, launched, dir);
    }

    [Test]
    public async Task 新しい版を落として確かめて入れる()
    {
        var (u, _, launched, _) = Setup(goodSig: true);
        await Assert.That((await u.Check()).Available).IsTrue();
        await Assert.That(await u.Apply(() => true)).IsTrue();
        await Assert.That(launched.Count).IsEqualTo(1);
        await Assert.That(File.ReadAllText(launched[0])).IsEqualTo("MSI");
    }

    [Test]
    public async Task 署名が合わなければ入れずに消し_その版は取り直さない()
    {
        var (u, _, launched, dir) = Setup(goodSig: false);
        await u.Check();
        await Assert.That(await u.Apply(() => true)).IsFalse();
        await Assert.That(launched.Count).IsEqualTo(0);
        await Assert.That(Directory.GetFiles(Path.Combine(dir, "updates")).Length).IsEqualTo(0);
        await Assert.That((await u.Check()).Available).IsFalse();
    }

    [Test]
    public async Task つないでいる人がいれば入れず_次は落とし直さない()
    {
        var (u, gh, launched, _) = Setup(goodSig: true);
        await u.Check();
        var calls = 0;
        // 1 回目: 落としたあと(2 回目の問い合わせで)つないでいる人がいる
        await Assert.That(await u.Apply(() => ++calls < 2)).IsFalse();
        await Assert.That(launched.Count).IsEqualTo(0);
        // 2 回目: 誰もいない。前に落として確かめたものを使う
        await Assert.That(await u.Apply(() => true)).IsTrue();
        await Assert.That(gh.MsiDownloads).IsEqualTo(1);
        await Assert.That(launched.Count).IsEqualTo(1);
    }

    [Test]
    public async Task 今より古いか同じ版は入れない()
    {
        var (pub, sign) = NewKey();
        var gh = new FakeGitHub("v0.5.0", "MSI"u8.ToArray(), () => "");
        var tmp = Directory.CreateTempSubdirectory("mado-update-").FullName;
        var u = new Updater("x/y", "v0.5.0", tmp, Path.Combine(tmp, "logs"), new HttpClient(gh), _ => { }, (_, _) => throw new InvalidOperationException(), pub);
        await Assert.That((await u.Check()).Available).IsFalse();
        await Assert.That(await u.Apply(() => true)).IsFalse();
    }

    [Test]
    public async Task 入れ損ねても同じ版は_1_時間は起動し直さない()
    {
        var (u, _, launched, _) = Setup(goodSig: true);
        await u.Check();
        await Assert.That(await u.Apply(() => true)).IsTrue();
        // msiexec が失敗してまだ古い版のまま(Available のまま)でも、すぐには入れ直さない
        await Assert.That(await u.Apply(() => true)).IsFalse();
        await Assert.That(launched.Count).IsEqualTo(1);
    }
}
