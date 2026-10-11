using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Mado.Tests;

/// <summary>ID トークンの確かめ方。偽の IdP(HttpMessageHandler)が、ここで作った RSA の鍵で署名する。
/// 鍵は試験ごとに作り、並べて走らせない(Windows の CNG で 1 つの鍵を並列に使うと落ちた)</summary>
[NotInParallel]
public class OidcTests
{
    const string Issuer = "https://idp.example.test";
    const string ClientId = "client";
    readonly RSA Key = RSA.Create(2048);

    sealed class FakeIdp(RSA key) : HttpMessageHandler
    {
        public int JwksFetches;
        public bool JwksDown;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            var path = req.RequestUri!.AbsolutePath;
            string body;
            if (path.EndsWith("openid-configuration"))
                body = $$"""{"issuer":"{{Issuer}}","authorization_endpoint":"{{Issuer}}/auth","token_endpoint":"{{Issuer}}/token","jwks_uri":"{{Issuer}}/jwks"}""";
            else if (path == "/jwks")
            {
                if (JwksDown) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
                JwksFetches++;
                var p = key.ExportParameters(false);
                body = $$"""{"keys":[{"kty":"RSA","kid":"k1","n":"{{B64(p.Modulus!)}}","e":"{{B64(p.Exponent!)}}"}]}""";
            }
            else return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
        }
    }

    static string B64(byte[] b) => Base64Url.EncodeToString(b);
    static string B64(string s) => B64(Encoding.UTF8.GetBytes(s));

    string Token(string? claims = null, string alg = "RS256", string kid = "k1", RSA? key = null)
    {
        var exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600;
        claims ??= $$"""{"iss":"{{Issuer}}","sub":"u1","aud":"{{ClientId}}","exp":{{exp}},"nonce":"n1","name":"名前","roles":["admin"]}""";
        var head = B64($$"""{"alg":"{{alg}}","kid":"{{kid}}"}""");
        var body = B64(claims);
        var sig = (key ?? Key).SignData(Encoding.ASCII.GetBytes($"{head}.{body}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{head}.{body}.{B64(sig)}";
    }

    (Oidc Oidc, FakeIdp Idp) New()
    {
        var idp = new FakeIdp(Key);
        return (new Oidc(new Config.OidcOptions(Issuer, ClientId, "secret", "admin"), "https://md/callback", new HttpClient(idp)), idp);
    }

    [Test]
    public async Task 正しいトークンは通る()
    {
        var (oidc, _) = New();
        var claims = await oidc.Verify(Token(), "n1");
        await Assert.That(claims.Sub).IsEqualTo("u1");
        await Assert.That(claims.Roles!.Contains("admin")).IsTrue();
    }

    [Test]
    public async Task 署名方式が_none_なら通さない()
    {
        var (oidc, _) = New();
        var head = B64("""{"alg":"none","kid":"k1"}""");
        var body = Token().Split('.')[1];
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify($"{head}.{body}.", "n1"));
    }

    [Test]
    public async Task 別の鍵で署名したものは通さない()
    {
        var (oidc, _) = New();
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(Token(key: RSA.Create(2048)), "n1"));
    }

    [Test]
    public async Task 中身を書き換えたら通さない()
    {
        var (oidc, _) = New();
        var parts = Token().Split('.');
        var forged = B64($$"""{"iss":"{{Issuer}}","sub":"admin","aud":"{{ClientId}}","exp":9999999999,"nonce":"n1"}""");
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify($"{parts[0]}.{forged}.{parts[2]}", "n1"));
    }

    [Test]
    public async Task nonce_が違えば通さない()
    {
        var (oidc, _) = New();
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(Token(), "other"));
    }

    [Test]
    public async Task 宛先が違えば通さない()
    {
        var (oidc, _) = New();
        var exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600;
        var t = Token($$"""{"iss":"{{Issuer}}","sub":"u1","aud":"someone-else","exp":{{exp}},"nonce":"n1"}""");
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(t, "n1"));
    }

    [Test]
    public async Task 期限切れなら通さない()
    {
        var (oidc, _) = New();
        var exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 3600;
        var t = Token($$"""{"iss":"{{Issuer}}","sub":"u1","aud":"{{ClientId}}","exp":{{exp}},"nonce":"n1"}""");
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(t, "n1"));
    }

    [Test]
    public async Task 発行元が違えば通さない()
    {
        var (oidc, _) = New();
        var exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600;
        var t = Token($$"""{"iss":"https://evil.test","sub":"u1","aud":"{{ClientId}}","exp":{{exp}},"nonce":"n1"}""");
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(t, "n1"));
    }

    [Test]
    public async Task 壊れたトークンは形が違うと言う()
    {
        var (oidc, _) = New();
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify("a.b", "n1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify("!!!.!!!.!!!", "n1"));
    }

    [Test]
    public async Task 知らない_kid_で何度来ても_JWKS_は取り直しすぎない()
    {
        var (oidc, idp) = New();
        await oidc.Verify(Token(), "n1");
        for (var i = 0; i < 5; i++)
            await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(Token(kid: $"x{i}"), "n1"));
        await Assert.That(idp.JwksFetches).IsEqualTo(1);
    }

    [Test]
    public async Task JWKS_が一時的に取れなくても次のログインで取り直せる()
    {
        var (oidc, idp) = New();
        idp.JwksDown = true;
        await Assert.ThrowsAsync<InvalidOperationException>(() => oidc.Verify(Token(), "n1"));
        idp.JwksDown = false;
        await Assert.That((await oidc.Verify(Token(), "n1")).Sub).IsEqualTo("u1");
    }
}