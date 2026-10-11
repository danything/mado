using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mado;

internal sealed record User(
    [property: JsonPropertyName("sub")] string Sub,
    [property: JsonPropertyName("name")] string Name);

/// <summary>ログインの途中の値。署名付きの Cookie に持つので、サーバーは何も覚えない</summary>
internal sealed record Pending(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("verifier")] string Verifier,
    [property: JsonPropertyName("to")] string To);

/// <summary>誰が・どこへ。つなぐ先はここで決まり、ブラウザが RDCleanPath に入れてくる行き先は見ない</summary>
internal sealed record RelayToken(
    [property: JsonPropertyName("sub")] string Sub,
    [property: JsonPropertyName("target")] string Target,
    [property: JsonPropertyName("jti")] string Jti);

internal sealed record OidcDiscovery(
    [property: JsonPropertyName("issuer")] string Issuer,
    [property: JsonPropertyName("authorization_endpoint")] string AuthorizationEndpoint,
    [property: JsonPropertyName("token_endpoint")] string TokenEndpoint,
    [property: JsonPropertyName("jwks_uri")] string JwksUri);

internal sealed record OidcToken(
    [property: JsonPropertyName("id_token")] string? IdToken,
    [property: JsonPropertyName("error_description")] string? ErrorDescription);

internal sealed record Jwk(
    [property: JsonPropertyName("kty")] string? Kty,
    [property: JsonPropertyName("kid")] string? Kid,
    [property: JsonPropertyName("n")] string? N,
    [property: JsonPropertyName("e")] string? E);

internal sealed record Jwks([property: JsonPropertyName("keys")] Jwk[]? Keys);

internal sealed record JwtHeader(
    [property: JsonPropertyName("alg")] string? Alg,
    [property: JsonPropertyName("kid")] string? Kid);

internal sealed record JwtClaims(
    [property: JsonPropertyName("iss")] string? Iss,
    [property: JsonPropertyName("sub")] string? Sub,
    [property: JsonPropertyName("aud")] JsonElement Aud,
    [property: JsonPropertyName("exp")] long? Exp,
    [property: JsonPropertyName("nbf")] long? Nbf,
    [property: JsonPropertyName("nonce")] string? Nonce,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("preferred_username")] string? PreferredUsername,
    [property: JsonPropertyName("roles")] string[]? Roles);

internal sealed class Forbidden(string message) : Exception(message);

/// <summary>
/// OIDC(認可コード + PKCE)でのログイン。
///
/// ライブラリは入れない(denpa の oidc.ts、bun 版の mado と同じ考え)。使う口は discovery・authorize・token・jwks の 4 つだけで、
/// HttpClient と System.Security.Cryptography で足りる。ASP.NET Core の OpenIdConnect の仕組みは Native AOT に対応していない。
/// 相手は Entra ID を想定しているが、使うのは OIDC の標準だけ。
/// </summary>
internal sealed class Oidc(Config.OidcOptions c, string redirectUri, HttpClient http)
{
    OidcDiscovery? discovered;
    /// <summary>kid ごとの公開鍵。相手が鍵を入れ替えたときのために、見つからなければ取り直す</summary>
    readonly Dictionary<string, RSA> keys = [];
    /// <summary>時計のずれの許容(秒)</summary>
    const int Skew = 60;

    public static string RandomToken(int bytes = 32) => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(bytes));

    /// <summary>戻る先は自分のところの絶対パスだけ(`//evil.example` で外へ飛ばす踏み台にしない)</summary>
    public static string SafeReturn(string? to) => to is not null && to.StartsWith('/') && !to.StartsWith("//") ? to : "/";

    /// <summary>口の一覧。一度読んだら覚える(取れなかったときは覚えず、次にまた取りに行く)</summary>
    async Task<OidcDiscovery> Discover()
    {
        if (discovered is not null) return discovered;
        var url = $"{c.Issuer.TrimEnd('/')}/.well-known/openid-configuration";
        using var res = await http.GetAsync(url);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"OIDC の設定を読めない ({(int)res.StatusCode}) {url}");
        discovered = JsonSerializer.Deserialize(await res.Content.ReadAsStringAsync(), ApiJson.Default.OidcDiscovery)
            ?? throw new InvalidOperationException("OIDC の設定が空");
        return discovered;
    }

    public async Task<(string Url, Pending Pending)> Start(string to)
    {
        var doc = await Discover();
        var pending = new Pending(RandomToken(), RandomToken(), RandomToken(), to);
        var challenge = Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(pending.Verifier)));
        var q = new Dictionary<string, string>
        {
            ["client_id"] = c.ClientId,
            ["response_type"] = "code",
            ["redirect_uri"] = redirectUri,
            ["scope"] = "openid profile",
            ["state"] = pending.State,
            ["nonce"] = pending.Nonce,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
        };
        var query = string.Join('&', q.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
        return ($"{doc.AuthorizationEndpoint}?{query}", pending);
    }

    /// <summary>戻ってきたコードを確かめ切ってユーザーを返す。通さない人なら Forbidden</summary>
    public async Task<User> Finish(string code, Pending pending)
    {
        var claims = await Verify(await Exchange(code, pending.Verifier), pending.Nonce);
        if (c.RequiredRole != "" && !(claims.Roles ?? []).Contains(c.RequiredRole))
            throw new Forbidden($"ロール {c.RequiredRole} が割り当てられていない");
        return new User(claims.Sub!, claims.Name ?? claims.PreferredUsername ?? claims.Sub!);
    }

    /// <summary>コードを ID トークンに換える。秘密は本文に入れて送る(client_secret_post)</summary>
    async Task<string> Exchange(string code, string verifier)
    {
        var doc = await Discover();
        using var res = await http.PostAsync(doc.TokenEndpoint, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = redirectUri,
            ["client_id"] = c.ClientId,
            ["client_secret"] = c.ClientSecret,
            ["code_verifier"] = verifier,
        }));
        OidcToken? body = null;
        try { body = JsonSerializer.Deserialize(await res.Content.ReadAsStringAsync(), ApiJson.Default.OidcToken); }
        catch (JsonException) { }
        if (!res.IsSuccessStatusCode || body?.IdToken is not { } idToken)
            throw new InvalidOperationException($"トークンを取得できない ({(int)res.StatusCode}) {body?.ErrorDescription}".Trim());
        return idToken;
    }

    async Task<RSA> PublicKey(string kid)
    {
        if (keys.TryGetValue(kid, out var cached)) return cached;
        var doc = await Discover();
        using var res = await http.GetAsync(doc.JwksUri);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"署名の鍵を取得できない ({(int)res.StatusCode})");
        var jwks = JsonSerializer.Deserialize(await res.Content.ReadAsStringAsync(), ApiJson.Default.Jwks);
        foreach (var k in jwks?.Keys ?? [])
        {
            if (k.Kid is null || k.Kty != "RSA" || k.N is null || k.E is null) continue;
            var rsa = RSA.Create();
            rsa.ImportParameters(new RSAParameters { Modulus = Base64Url.DecodeFromChars(k.N), Exponent = Base64Url.DecodeFromChars(k.E) });
            keys[k.Kid] = rsa;
        }
        return keys.TryGetValue(kid, out var found) ? found : throw new InvalidOperationException($"ID トークンの鍵 ({kid}) が見つからない");
    }

    /// <summary>ID トークンの署名まで確かめる(認可コードフローでは省いてよいことになっているが、数行なので省かない)</summary>
    async Task<JwtClaims> Verify(string token, string nonce)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) throw new InvalidOperationException("ID トークンの形が違う");
        var header = JsonSerializer.Deserialize(Base64Url.DecodeFromChars(parts[0]), ApiJson.Default.JwtHeader);
        // none を受けると署名を見ない道ができる。受けるのは RS256 だけ
        if (header?.Alg != "RS256") throw new InvalidOperationException($"対応していない署名方式 ({header?.Alg})");
        if (header.Kid is null) throw new InvalidOperationException("ID トークンに鍵の名前が無い");
        var key = await PublicKey(header.Kid);
        if (!key.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), Base64Url.DecodeFromChars(parts[2]),
                HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new InvalidOperationException("ID トークンの署名が合わない");

        var claims = JsonSerializer.Deserialize(Base64Url.DecodeFromChars(parts[1]), ApiJson.Default.JwtClaims)
            ?? throw new InvalidOperationException("ID トークンが空");
        if (claims.Iss != (await Discover()).Issuer) throw new InvalidOperationException("ID トークンの発行元が違う");
        var aud = claims.Aud.ValueKind switch
        {
            JsonValueKind.String => [claims.Aud.GetString()],
            JsonValueKind.Array => claims.Aud.EnumerateArray().Select(a => a.GetString()).ToArray(),
            _ => Array.Empty<string?>(),
        };
        if (!aud.Contains(c.ClientId)) throw new InvalidOperationException("ID トークンの宛先が違う");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (claims.Exp is not { } exp || exp + Skew < now) throw new InvalidOperationException("ID トークンの期限が切れている");
        if (claims.Nbf is { } nbf && nbf - Skew > now) throw new InvalidOperationException("ID トークンがまだ有効でない");
        // 出したときの合言葉と一致すること。これが「自分が始めたログイン」の証拠
        if (claims.Nonce != nonce) throw new InvalidOperationException("ID トークンの nonce が合わない");
        if (string.IsNullOrEmpty(claims.Sub)) throw new InvalidOperationException("ID トークンに sub が無い");
        return claims;
    }
}
