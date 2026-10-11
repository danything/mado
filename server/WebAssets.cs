using System.Reflection;

namespace Mado;

/// <summary>
/// 画面(web/ を bun build したもの)を exe の中から配る。名前に内容のハッシュが入るもの(index-xxxx.js など)は
/// 長く覚えさせ、index.html は毎回取り直させる。
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
        ".wasm" => "application/wasm",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };

    public static bool Has(string path) => files.ContainsKey(path == "/" ? "/index.html" : path);

    public static async Task Serve(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value is "/" or null ? "/index.html" : ctx.Request.Path.Value;
        var (body, type) = files[path];
        ctx.Response.ContentType = type;
        ctx.Response.Headers.CacheControl = path == "/index.html" ? "no-cache" : "public, max-age=31536000, immutable";
        ctx.Response.ContentLength = body.Length;
        await ctx.Response.Body.WriteAsync(body);
    }
}
