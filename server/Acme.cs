using System.Buffers.Text;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Mado;

/// <summary>
/// Let's Encrypt から証明書を取る ACME(RFC 8555)のクライアント。HTTP-01 だけ。
///
/// ライブラリは入れない。使うのは新しいアカウント・注文・認可・確定・ダウンロードの決まった順の POST だけで、
/// 署名(JWS ES256)は ECDsa、CSR は CertificateRequest で足りる。
///
/// dataDir に置くもの(bun 版と同じ形。入れ替えてもそのまま使える): acme-account.json(アカウントの鍵 JWK と URL)、
/// tls.key / tls.crt(証明書の鍵と連なり、PEM)。
/// </summary>
internal sealed class Acme(
    string host, string email, bool staging, string dataDir,
    IDictionary<string, string> challenges, HttpClient http, Action<string> log)
{
    const string Production = "https://acme-v02.api.letsencrypt.org/directory";
    const string Staging = "https://acme-staging-v02.api.letsencrypt.org/directory";
    /// <summary>残りがこれを切ったら取り直す</summary>
    public const int RenewBeforeDays = 30;

    string? nonce;
    JsonNode dir = null!;
    ECDsa key = null!;
    JsonObject jwk = null!;
    string? accountUrl;
    string thumbprint = "";

    string AccountFile => Path.Combine(dataDir, "acme-account.json");
    string KeyFile => Path.Combine(dataDir, "tls.key");
    string CertFile => Path.Combine(dataDir, "tls.crt");

    /// <summary>置いてある証明書。期限が近い(または無い)なら取り直す</summary>
    public async Task<(string KeyPem, string CertPem, bool Renewed)> Ensure()
    {
        if (File.Exists(KeyFile) && File.Exists(CertFile))
        {
            var pem = await File.ReadAllTextAsync(CertFile);
            if (DaysLeft(pem) > RenewBeforeDays) return (await File.ReadAllTextAsync(KeyFile), pem, false);
        }
        var (k, c) = await Issue();
        Directory.CreateDirectory(dataDir);
        await File.WriteAllTextAsync(KeyFile, k);
        await File.WriteAllTextAsync(CertFile, c);
        return (k, c, true);
    }

    async Task<(string KeyPem, string CertPem)> Issue()
    {
        await Init();
        log($"acme: {host} の証明書を取る");
        var (order, orderUrl) = await Post(dir["newOrder"]!.GetValue<string>(),
            new JsonObject { ["identifiers"] = new JsonArray(new JsonObject { ["type"] = "dns", ["value"] = host }) });

        foreach (var a in order["authorizations"]!.AsArray())
        {
            var authzUrl = a!.GetValue<string>();
            var (authz, _) = await Post(authzUrl);
            if (authz["status"]?.GetValue<string>() == "valid") continue;
            var ch = authz["challenges"]!.AsArray().FirstOrDefault(c => c!["type"]?.GetValue<string>() == "http-01")
                ?? throw new InvalidOperationException("acme: http-01 の課題が無い");
            var token = ch["token"]!.GetValue<string>();
            challenges[token] = $"{token}.{thumbprint}";
            try
            {
                await Post(ch["url"]!.GetValue<string>(), new JsonObject());
                await Poll(authzUrl, "認可");
            }
            finally
            {
                challenges.Remove(token);
            }
        }

        using var certKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest($"CN={host}", certKey, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName(host);
        req.CertificateExtensions.Add(san.Build());
        await Post(order["finalize"]!.GetValue<string>(),
            new JsonObject { ["csr"] = Base64Url.EncodeToString(req.CreateSigningRequest()) });
        var done = await Poll(orderUrl!, "注文");
        using var res = await PostRaw(done["certificate"]!.GetValue<string>(), null, "application/pem-certificate-chain");
        var cert = await res.Content.ReadAsStringAsync();
        log($"acme: 取れた(残り {(int)DaysLeft(cert)} 日)");
        return (certKey.ExportPkcs8PrivateKeyPem(), cert);
    }

    async Task Init()
    {
        dir = JsonNode.Parse(await http.GetStringAsync(staging ? Staging : Production))!;
        if (File.Exists(AccountFile))
        {
            var acc = JsonNode.Parse(await File.ReadAllTextAsync(AccountFile))!;
            jwk = acc["jwk"]!.AsObject();
            accountUrl = acc["url"]?.GetValue<string>();
            key = ECDsa.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                D = Base64Url.DecodeFromChars(jwk["d"]!.GetValue<string>()),
                Q = new ECPoint
                {
                    X = Base64Url.DecodeFromChars(jwk["x"]!.GetValue<string>()),
                    Y = Base64Url.DecodeFromChars(jwk["y"]!.GetValue<string>()),
                },
            });
        }
        else
        {
            key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var p = key.ExportParameters(true);
            jwk = new JsonObject
            {
                ["crv"] = "P-256",
                ["kty"] = "EC",
                ["x"] = Base64Url.EncodeToString(p.Q.X),
                ["y"] = Base64Url.EncodeToString(p.Q.Y),
                ["d"] = Base64Url.EncodeToString(p.D),
            };
        }
        // RFC 7638: 必須の要素だけを辞書順で並べた JSON の SHA-256
        var canonical = $"{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{jwk["x"]}\",\"y\":\"{jwk["y"]}\"}}";
        thumbprint = Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));

        if (accountUrl is null)
        {
            var (_, location) = await Post(dir["newAccount"]!.GetValue<string>(), new JsonObject
            {
                ["termsOfServiceAgreed"] = true,
                ["contact"] = new JsonArray($"mailto:{email}"),
            });
            accountUrl = location ?? throw new InvalidOperationException("acme: アカウントの URL が返ってこない");
            Directory.CreateDirectory(dataDir);
            await File.WriteAllTextAsync(AccountFile,
                new JsonObject { ["jwk"] = jwk.DeepClone(), ["url"] = accountUrl }.ToJsonString());
        }
    }

    /// <summary>状態が valid になるまで待つ(Retry-After があれば従う)</summary>
    async Task<JsonNode> Poll(string url, string what)
    {
        for (var i = 0; i < 30; i++)
        {
            using var res = await PostRaw(url, null);
            var body = JsonNode.Parse(await res.Content.ReadAsStringAsync())!;
            var status = body["status"]?.GetValue<string>();
            if (status == "valid") return body;
            if (status == "invalid") throw new InvalidOperationException($"acme: {what}が通らない {body.ToJsonString()}");
            var wait = res.Headers.RetryAfter?.Delta ?? TimeSpan.FromSeconds(2);
            await Task.Delay(wait);
        }
        throw new InvalidOperationException($"acme: {what}が終わらない");
    }

    /// <summary>payload を省くと POST-as-GET</summary>
    async Task<(JsonNode Body, string? Location)> Post(string url, JsonObject? payload = null)
    {
        using var res = await PostRaw(url, payload);
        return (JsonNode.Parse(await res.Content.ReadAsStringAsync())!, res.Headers.Location?.ToString());
    }

    async Task<HttpResponseMessage> PostRaw(string url, JsonObject? payload, string accept = "application/json", bool retried = false)
    {
        var n = nonce ?? await NewNonce();
        nonce = null;
        var header = new JsonObject { ["alg"] = "ES256", ["nonce"] = n, ["url"] = url };
        if (accountUrl is not null) header["kid"] = accountUrl;
        else header["jwk"] = new JsonObject { ["crv"] = "P-256", ["kty"] = "EC", ["x"] = jwk["x"]!.DeepClone(), ["y"] = jwk["y"]!.DeepClone() };
        var p = B64(header.ToJsonString());
        var body = payload is null ? "" : B64(payload.ToJsonString());
        // ECDsa.SignData の既定の形は r || s(IEEE P1363)で、JWS の ES256 と同じ
        var sig = key.SignData(Encoding.ASCII.GetBytes($"{p}.{body}"), HashAlgorithmName.SHA256);
        var jws = new JsonObject { ["protected"] = p, ["payload"] = body, ["signature"] = Base64Url.EncodeToString(sig) };
        var msg = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(jws.ToJsonString(), Encoding.UTF8, "application/jose+json"),
        };
        msg.Content.Headers.ContentType!.CharSet = null;
        msg.Headers.Accept.ParseAdd(accept);
        var res = await http.SendAsync(msg);
        nonce = res.Headers.TryGetValues("Replay-Nonce", out var v) ? v.FirstOrDefault() : null;
        if (res.IsSuccessStatusCode) return res;
        var err = JsonNode.Parse(await res.Content.ReadAsStringAsync() is { Length: > 0 } s ? s : "{}");
        var type = err?["type"]?.GetValue<string>();
        res.Dispose();
        // nonce の使い回しを弾かれたら、新しい nonce で 1 回だけやり直す(RFC 8555 6.5)
        if (!retried && type == "urn:ietf:params:acme:error:badNonce") return await PostRaw(url, payload, accept, true);
        throw new InvalidOperationException($"acme: {url} ({(int)res.StatusCode}) {type} {err?["detail"]}".Trim());
    }

    async Task<string> NewNonce()
    {
        using var res = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, dir["newNonce"]!.GetValue<string>()));
        return res.Headers.TryGetValues("Replay-Nonce", out var v) ? v.First() : throw new InvalidOperationException("acme: nonce が取れない");
    }

    static string B64(string s) => Base64Url.EncodeToString(Encoding.UTF8.GetBytes(s));

    /// <summary>PEM の最初の証明書の残り日数</summary>
    public static double DaysLeft(string pem) =>
        (X509Certificate2.CreateFromPem(pem).NotAfter.ToUniversalTime() - DateTime.UtcNow).TotalDays;

    /// <summary>
    /// Kestrel に渡す形。Windows の SChannel は PEM から作った一時的な鍵を受けないので、一度 PKCS#12 にして読み直す。
    /// 途中の証明書(Let's Encrypt の中間)も一緒に送る
    /// </summary>
    public static SslStreamCertificateContext Context(string keyPem, string certPem)
    {
        using var leaf = X509Certificate2.CreateFromPem(certPem, keyPem);
        var cert = X509CertificateLoader.LoadPkcs12(leaf.Export(X509ContentType.Pkcs12), null);
        var all = new X509Certificate2Collection();
        all.ImportFromPem(certPem);
        var intermediates = new X509Certificate2Collection();
        foreach (var c in all)
            if (c.Thumbprint != cert.Thumbprint) intermediates.Add(c);
        return SslStreamCertificateContext.Create(cert, intermediates, offline: true);
    }
}
