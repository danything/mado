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
}
