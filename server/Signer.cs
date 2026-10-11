using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Mado;

/// <summary>
/// 署名付きの小さな値(Cookie とページに渡すトークン)。中身は JSON に exp(秒)を足したもので、HMAC-SHA256 で署名する。
/// 鍵は dataDir/session.key(初回に作る)。鍵を消せば、出したものは全部使えなくなる。形は bun 版と同じ。
/// </summary>
internal sealed class Signer(byte[] key)
{
    public static Signer Open(string dataDir)
    {
        var file = Path.Combine(dataDir, "session.key");
        Directory.CreateDirectory(dataDir);
        try
        {
            // 無いときだけ作る(CreateNew)。同時に作ろうとしたら、先に作ったほうを読む
            using var f = new FileStream(file, FileMode.CreateNew, FileAccess.Write);
            var key = RandomNumberGenerator.GetBytes(32);
            f.Write(key);
            return new Signer(key);
        }
        catch (IOException) when (File.Exists(file))
        {
            return new Signer(File.ReadAllBytes(file));
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
