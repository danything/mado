// mado: OIDC でログインして、ブラウザから RDP する小さなゲートウェイ。Windows のサービスとして動く。
//
//   https://<host>/             画面(IronRDP の Web クライアント。web/ を bun でビルドして exe に埋め込んだもの)
//   https://<host>/login        OIDC のログインへ
//   https://<host>/callback     OIDC から戻ってくる口
//   https://<host>/api/session  ログイン中の名前・版・つなぐ先
//   https://<host>/api/token    つなぐ直前に取る、使い捨ての中継のトークン(?target=<name>)
//   wss://<host>/ws             RDCleanPath の中継(Relay.cs)
//   http://<host>/.well-known/acme-challenge/*  Let's Encrypt の確認(80 番。ほかは https へ)
//   http://127.0.0.1:8788/status  この PC の中からだけ見られる状態

using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Reflection;
using Mado;
using Microsoft.AspNetCore.Server.Kestrel.Https;

Config config;
try
{
    config = Config.Load(args);
}
catch (Exception e) when (e is ConfigException or IOException or UnauthorizedAccessException)
{
    Console.Error.WriteLine(e.Message);
    return 1;
}

var log = new FileLog(Path.Combine(Path.GetDirectoryName(config.File)!, "logs", "mado.log"));
var version = "v" + (typeof(Config).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
    .Split('+')[0] ?? "0.0.0");
log.Write($"mado {version}: {config.File} を読んだ({config.Host}、つなぐ先 {string.Join(' ', config.Targets.Select(t => $"{t.Name}={t.Host}:{t.Port}"))})");

var signer = Signer.Open(config.DataDir);
var origin = config.Origin;
var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
http.DefaultRequestHeaders.UserAgent.ParseAdd($"mado/{version}");
var oidc = new Oidc(config.Oidc, $"{origin}/callback", http);
var secure = config.Tls == "acme";

const string SessionCookie = "mado";
const string PendingCookie = "mado_login";
// ログインしていられる時間。切れたら OIDC に行き直す(Entra 側にセッションがあれば一瞬で戻る)
const int SessionSeconds = 8 * 60 * 60;
// /api/token が出す中継のトークンの寿命。ページが受け取ってすぐ使う
const int RelayTokenSeconds = 60;

var challenges = new ConcurrentDictionary<string, string>();
var acme = new Acme(config.Host, config.Acme.Email, config.Acme.Staging, config.DataDir, challenges, http, log.Write);
SslStreamCertificateContext? current = null;
int? certDaysLeft = null;
var sessions = 0;
var startedAt = DateTimeOffset.UtcNow.ToString("o");
var updater = new Updater(config.Update.Repo, version, config.DataDir, http, log.Write);
// サービスとして動いているときだけ自分で上げる(手元で dotnet run しているときは入れる MSI が無い)
var canUpdate = config.Update.Enabled && OperatingSystem.IsWindows()
    && Microsoft.Extensions.Hosting.WindowsServices.WindowsServiceHelpers.IsWindowsService();

var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.Host.UseWindowsService(o => o.ServiceName = "mado");
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(k =>
{
    var any = config.Listen.Hostname is "::" or "0.0.0.0" or "" ? null : IPAddress.Parse(config.Listen.Hostname);
    void Listen(int port, Action<Microsoft.AspNetCore.Server.Kestrel.Core.ListenOptions>? configure = null)
    {
        // IPv6Any は IPv4 も受ける(デュアルスタック)
        if (any is null) k.ListenAnyIP(port, configure ?? (_ => { }));
        else k.Listen(any, port, configure ?? (_ => { }));
    }
    Listen(config.Listen.Http);
    if (secure)
        Listen(config.Listen.Https, lo => lo.UseHttps(new TlsHandshakeCallbackOptions
        {
            // 証明書は取り直したら差し替える(つながっている RDP は切れない。新しい接続から新しい証明書)
            OnConnection = _ => ValueTask.FromResult(new SslServerAuthenticationOptions
            {
                ServerCertificateContext = current ?? throw new InvalidOperationException("証明書がまだ無い"),
            }),
        }));
    if (config.StatusPort != 0) k.Listen(IPAddress.Loopback, config.StatusPort);
});

var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

IResult Text(int status, string body) => Results.Text(body, "text/plain; charset=utf-8", statusCode: status);
User? SessionOf(HttpContext ctx) => signer.Verify(ctx.Request.Cookies[SessionCookie], ApiJson.Default.User);
CookieOptions Cookie(int maxAge) => new()
{
    HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Lax, Path = "/", MaxAge = TimeSpan.FromSeconds(maxAge),
};
Target? TargetOf(string? name) => config.Targets.FirstOrDefault(t => t.Name == name);

// 使ったトークン(jti → 期限)。使い回しを弾く
var used = new ConcurrentDictionary<string, long>();
Target? Consume(string? token, string sub)
{
    var t = signer.Verify(token, ApiJson.Default.RelayToken);
    if (t is null || t.Sub != sub || !used.TryAdd(t.Jti, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + RelayTokenSeconds)) return null;
    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    foreach (var (k, exp) in used)
        if (exp < now) used.TryRemove(k, out _);
    return TargetOf(t.Target);
}

// どのポートに来たかで分ける: 80 は ACME と https への案内、状態の口は状態だけ、ほかは本体
app.Use(async (ctx, next) =>
{
    var port = ctx.Connection.LocalPort;
    if (config.StatusPort != 0 && port == config.StatusPort)
    {
        // Host を確かめる(DNS リバインディングで、よその名前のまま 127.0.0.1 に来るのを弾く)
        var host = ctx.Request.Host.Value;
        if (host != $"127.0.0.1:{port}" && host != $"localhost:{port}") { await Text(403, "host が違う").ExecuteAsync(ctx); return; }
        if (ctx.Request.Path == "/status" && HttpMethods.IsGet(ctx.Request.Method))
        {
            await Results.Json(new Status(version, origin, startedAt, sessions, certDaysLeft, updater.State), ApiJson.Default.Status).ExecuteAsync(ctx);
            return;
        }
        // 今すぐ新しい版を確かめて、あれば入れる(タスクトレイから)。ほかのサイトのページから投げさせないため、
        // `x-mado: 1` のヘッダーを求める(足すと CORS の事前確認が要り、それには答えない)
        if (ctx.Request.Path == "/update" && HttpMethods.IsPost(ctx.Request.Method))
        {
            if (ctx.Request.Headers["x-mado"] != "1") { await Text(403, "x-mado: 1 が要る").ExecuteAsync(ctx); return; }
            var started = canUpdate && (await updater.Check()).Available && await updater.Apply(() => sessions == 0);
            await Results.Json(new UpdateResult(started, updater.State), ApiJson.Default.UpdateResult).ExecuteAsync(ctx);
            return;
        }
        await Text(404, "not found").ExecuteAsync(ctx);
        return;
    }
    if (secure && port == config.Listen.Http)
    {
        var path = ctx.Request.Path.Value ?? "/";
        const string prefix = "/.well-known/acme-challenge/";
        if (path.StartsWith(prefix, StringComparison.Ordinal))
        {
            await (challenges.TryGetValue(path[prefix.Length..], out var answer) ? Text(200, answer) : Text(404, "not found")).ExecuteAsync(ctx);
            return;
        }
        ctx.Response.Redirect($"{origin}{path}{ctx.Request.QueryString}", permanent: true);
        return;
    }
    await next(ctx);
});

app.MapGet("/login", async (HttpContext ctx) =>
{
    var (url, pending) = await oidc.Start(Oidc.SafeReturn(ctx.Request.Query["to"]));
    ctx.Response.Cookies.Append(PendingCookie, signer.Sign(pending, ApiJson.Default.Pending, 600), Cookie(600));
    return Results.Redirect(url);
});

app.MapGet("/callback", async (HttpContext ctx) =>
{
    var q = ctx.Request.Query;
    var pending = signer.Verify(ctx.Request.Cookies[PendingCookie], ApiJson.Default.Pending);
    ctx.Response.Cookies.Delete(PendingCookie, new CookieOptions { Path = "/" });
    if (!string.IsNullOrEmpty(q["error"])) return Text(403, $"ログインできなかった: {(string.IsNullOrEmpty(q["error_description"]) ? q["error"] : q["error_description"])}");
    string? code = q["code"];
    if (pending is null || string.IsNullOrEmpty(code) || q["state"] != pending.State)
        return Text(400, "ログインの途中の情報が合わない。最初からやり直して(/login)");
    try
    {
        var user = await oidc.Finish(code, pending);
        ctx.Response.Cookies.Append(SessionCookie, signer.Sign(user, ApiJson.Default.User, SessionSeconds), Cookie(SessionSeconds));
        log.Write($"login: {user.Name} ({user.Sub})");
        return Results.Redirect(pending.To);
    }
    // どんな失敗でも理由をログに残して返す(ログ無しの 500 にしない)
    catch (Exception e)
    {
        log.Write($"login failed: {e.Message}");
        return Text(e is Forbidden ? 403 : 502, $"ログインできなかった: {e.Message}");
    }
});

app.MapGet("/logout", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Delete(SessionCookie, new CookieOptions { Path = "/" });
    return Text(200, "ログアウトした");
});

app.MapGet("/api/session", (HttpContext ctx) =>
{
    ctx.Response.Headers.CacheControl = "no-store";
    if (SessionOf(ctx) is not { } s) return Results.Json(new LoginRequired("/login?to=/"), ApiJson.Default.LoginRequired, statusCode: 401);
    var ws = (origin.StartsWith("https") ? "wss" : "ws") + origin[(origin.IndexOf(':'))..] + "/ws";
    return Results.Json(new SessionInfo(s.Name, version, [.. config.Targets.Select(t => t.Name)], ws), ApiJson.Default.SessionInfo);
});

app.MapGet("/api/token", (HttpContext ctx) =>
{
    ctx.Response.Headers.CacheControl = "no-store";
    if (SessionOf(ctx) is not { } s) return Results.Json(new LoginRequired("/login?to=/"), ApiJson.Default.LoginRequired, statusCode: 401);
    if (TargetOf(ctx.Request.Query["target"]) is not { } target) return Text(404, "そのつなぐ先は無い");
    var token = signer.Sign(new RelayToken(s.Sub, target.Name, Oidc.RandomToken(16)), ApiJson.Default.RelayToken, RelayTokenSeconds);
    return Results.Json(new TokenInfo(token), ApiJson.Default.TokenInfo);
});

app.Map("/ws", async (HttpContext ctx) =>
{
    // 別のサイトのページから、この Cookie を使ってつながせない
    if (ctx.Request.Headers.Origin != origin) { await Text(403, "origin が違う").ExecuteAsync(ctx); return; }
    if (SessionOf(ctx) is not { } user) { await Text(401, "ログインしていない").ExecuteAsync(ctx); return; }
    if (!ctx.WebSockets.IsWebSocketRequest) { await Text(400, "WebSocket で来て").ExecuteAsync(ctx); return; }
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    Interlocked.Increment(ref sessions);
    log.Write($"ws open: {user.Name}");
    try
    {
        await Relay.Run(ws, auth => Consume(auth, user.Sub), m => log.Write($"{user.Name}: {m}"), ctx.RequestAborted);
    }
    finally
    {
        Interlocked.Decrement(ref sessions);
        log.Write($"ws close: {user.Name}");
    }
});

app.MapGet("/{**path}", async (HttpContext ctx) =>
{
    if (!WebAssets.Has(ctx.Request.Path.Value ?? "/")) { await Text(404, "not found").ExecuteAsync(ctx); return; }
    await WebAssets.Serve(ctx);
});

if (secure)
{
    // 証明書: 取ってから待ち受け始めるのではなく、80 番で確認に答えられるように先に動かし、取れたら https に使う。
    // 12 時間ごとに残りを見る(30 日を切ったら取り直す)
    async Task Renew()
    {
        try
        {
            var (key, cert, renewed) = await acme.Ensure();
            certDaysLeft = (int)Acme.DaysLeft(cert);
            if (current is null || renewed)
            {
                current = Acme.Context(key, cert);
                log.Write($"https で待ち受け: {origin}(証明書の残り {certDaysLeft} 日)");
            }
        }
        catch (Exception e)
        {
            log.Write($"acme failed: {e.Message}");
        }
    }
    app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(async () =>
    {
        await Renew();
        using var timer = new PeriodicTimer(TimeSpan.FromHours(12));
        while (await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping)) await Renew();
    }));
}
else
{
    log.Write($"http で待ち受け: {origin}");
}

if (canUpdate)
{
    updater.Cleanup();
    // 起動直後は避けて 5 分後に 1 回、あとは check_hours ごと。つないでいて入れられなかったときは 10 分ごとに試す
    async Task TryUpdate()
    {
        if ((await updater.Check()).Available) await updater.Apply(() => sessions == 0);
    }
    app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(async () =>
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(5), app.Lifetime.ApplicationStopping);
            await TryUpdate();
            var last = DateTimeOffset.UtcNow;
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
            while (await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping))
            {
                var due = DateTimeOffset.UtcNow - last >= TimeSpan.FromHours(config.Update.CheckHours);
                if (!due && !updater.State.Available) continue;
                if (due) last = DateTimeOffset.UtcNow;
                await TryUpdate();
            }
        }
        catch (OperationCanceledException) { }
    }));
}

await app.RunAsync();
return 0;

/// <summary>ログ。サービスの標準出力はどこにも出ないので、ファイルにも書く。10 MB を超えたら .1 に回す</summary>
internal sealed class FileLog(string path)
{
    readonly Lock gate = new();

    public void Write(string msg)
    {
        var line = $"{DateTimeOffset.UtcNow:o} {msg}";
        Console.WriteLine(line);
        lock (gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length > 10 * 1024 * 1024) File.Move(path, path + ".1", overwrite: true);
                File.AppendAllText(path, line + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
