using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Mado;

/// <summary>
/// Cookie やページに渡すトークンに使う、署名付きの小さな値。JSON に秒単位の exp を足し、HMAC-SHA256 で署名する。
/// 鍵は dataDir/session.key で、初めて起動したときに作る。鍵を消すと、それまでに出したものは全部使えなくなる。形は bun 版と同じ。
/// </summary>
internal sealed class Signer(byte[] key)
{
    public static Signer Open(string dataDir)
    {
        var file = Path.Combine(dataDir, "session.key");
        Directory.CreateDirectory(dataDir);
        try
        {
            // CreateNew で、無いときだけ作る。ほかと同時に作ろうとしたら、先に作られたほうを読む
            using var f = new FileStream(file, FileMode.CreateNew, FileAccess.Write);
            var key = RandomNumberGenerator.GetBytes(32);
            f.Write(key);
            return new Signer(key);
        }
        catch (IOException) when (File.Exists(file))
        {
            var existing = File.ReadAllBytes(file);
            if (existing.Length == 32) return new Signer(existing);
            // 書きかけで終わったなどで壊れていたら作り直す。出したものは使えなくなるが、ログインし直せば済む
            var key = RandomNumberGenerator.GetBytes(32);
            File.WriteAllBytes(file, key);
            return new Signer(key);
        }
    }

    static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public string Sign<T>(T value, JsonTypeInfo<T> type, int ttlSeconds)
    {
        var node = System.Text.Json.JsonSerializer.SerializeToNode(value, type)!.AsObject();
        node["exp"] = Now + ttlSeconds;
        var body = Base64Url.EncodeToString(Encoding.UTF8.GetBytes(node.ToJsonString()));
        return $"{body}.{Mac(body)}";
    }

    /// <summary>署名と期限を確かめて中身を返す。だめなら null</summary>
    public T? Verify<T>(string? token, JsonTypeInfo<T> type) where T : class
    {
        if (string.IsNullOrEmpty(token)) return null;
        var dot = token.IndexOf('.');
        if (dot < 0) return null;
        var body = token[..dot];
        byte[] mac;
        try { mac = Base64Url.DecodeFromChars(token.AsSpan(dot + 1)); }
        catch (FormatException) { return null; }
        if (!CryptographicOperations.FixedTimeEquals(mac, Base64Url.DecodeFromChars(Mac(body)))) return null;
        try
        {
            var json = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(body));
            if (JsonNode.Parse(json)?["exp"]?.GetValue<long>() is not { } exp || exp <= Now) return null;
            return System.Text.Json.JsonSerializer.Deserialize(json, type);
        }
        catch (Exception e) when (e is FormatException or System.Text.Json.JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    string Mac(string body) => Base64Url.EncodeToString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(body)));
}
