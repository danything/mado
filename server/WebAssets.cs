using System.Reflection;

namespace Mado;

/// <summary>
/// web/ を bun build した画面を、exe の中から配る。index-xxxx.js のように名前に内容のハッシュが入るものは
/// ブラウザに長く覚えさせ、index.html は毎回取り直させる。
/// </summary>
internal static class WebAssets
{
    static readonly Dictionary<string, (byte[] Body, string Type)> files = Load();

    static Dictionary<string, (byte[], string)> Load()
    {
        var asm = Assembly.GetExecutingAssembly();
        var map = new Dictionary<string, (byte[], string)>(StringComparer.Ordinal);
        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith("web/", StringComparison.Ordinal)) continue;
            using var s = asm.GetManifestResourceStream(name)!;
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            var path = "/" + name["web/".Length..];
            map[path] = (ms.ToArray(), TypeOf(path));
        }
        return map;
    }

    static string TypeOf(string path) => Path.GetExtension(path) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };

    /// <summary>あれば返して true。無ければ何もせず false</summary>
    public static async Task<bool> TryServe(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value is "/" or null ? "/index.html" : ctx.Request.Path.Value;
        if (!files.TryGetValue(path, out var file)) return false;
        ctx.Response.ContentType = file.Type;
        ctx.Response.Headers.CacheControl = path == "/index.html" ? "no-cache" : "public, max-age=31536000, immutable";
        ctx.Response.ContentLength = file.Body.Length;
        await ctx.Response.Body.WriteAsync(file.Body);
        return true;
    }
}
