using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mado;

internal sealed record ReleaseAsset(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("browser_download_url")] string Url);

internal sealed record Release(
    [property: JsonPropertyName("tag_name")] string TagName,
    [property: JsonPropertyName("assets")] ReleaseAsset[] Assets);

internal sealed record UpdateState(
    [property: JsonPropertyName("latest")] string? Latest,
    [property: JsonPropertyName("available")] bool Available,
    [property: JsonPropertyName("checkedAt")] string? CheckedAt,
    [property: JsonPropertyName("error")] string? Error);

/// <summary>
/// 新しい版を入れる。GitHub の最新のリリースが今より新しければ mado.msi と mado.msi.sig を落とし、
/// 署名を確かめてから msiexec に渡す。サービスを止め、古い版を外し、新しい版を入れて起動するところは
/// MSI のメジャー アップグレードがやる。
///
/// 署名は CI の release.yml が `mado &lt;タグ&gt; &lt;MSI の SHA-256&gt;` に付ける。鍵は ECDSA P-256 で、秘密鍵は GitHub の secret MADO_SIGNING_KEY、
/// 確かめる公開鍵は下の PublicKey。タグも署名の中に入っているので、古い版を最新と偽って戻させることはできない。
/// そもそも今より新しい版しか受けないし、MSI も古い版では上書きしない。入れるのは誰もつないでいないときだけ。
/// </summary>
internal sealed class Updater(
    string repo, string version, string dataDir, string logDir, HttpClient http, Action<string> log,
    Action<string, string>? launch = null, string publicKey = Updater.PublicKey)
{
    /// <summary>release.yml の秘密鍵と対になる公開鍵。SubjectPublicKeyInfo を base64 にしたもの</summary>
    internal const string PublicKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExPX0Nm0/E8OPtFh/7BxycvGRy2DSjjnAJBTGRgFKpSngFDwF7QRI8d6cWHRD/WttcrUHR0Ci7Kn3uidHi0SMyQ==";

    public UpdateState State { get; private set; } = new(null, false, null, null);
    /// <summary>MSI とログの場所を受けて msiexec を起動する。試験では差し替える</summary>
    readonly Action<string, string> launch = launch ?? ((msi, msiLog) => Process.Start(new ProcessStartInfo("msiexec.exe")
    {
        ArgumentList = { "/i", msi, "/qn", "/norestart", "/l*v", msiLog },
        UseShellExecute = false,
    }));
    Release? release;
    /// <summary>署名が合わなかった版。次の版が出るまで取り直さない</summary>
    string? failed;
    /// <summary>msiexec を起動した版と時刻。入れ損ねたときに 10 分ごとに起動し直さないよう、同じ版は 1 時間空ける</summary>
    (string Tag, DateTimeOffset At)? launched;
    readonly SemaphoreSlim gate = new(1, 1);

    public static string Message(string tag, string sha256Hex) => $"mado {tag} {sha256Hex}";

    public static bool Verify(string message, string signatureB64, string publicKeyB64 = PublicKey)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeyB64), out _);
            return key.VerifyData(Encoding.UTF8.GetBytes(message), Convert.FromBase64String(signatureB64.Trim()), HashAlgorithmName.SHA256);
        }
        catch (FormatException) { return false; }
        catch (CryptographicException) { return false; }
    }

    /// <summary>"v1.2.3" / "1.2.3" を比べる。a が新しければ正</summary>
    public static int Compare(string a, string b)
    {
        static int[] Parse(string v) =>
            [.. v.TrimStart('v').Split('-', '+')[0].Split('.').Take(3).Select(x => int.TryParse(x, out var n) ? n : 0)];
        var (x, y) = (Parse(a), Parse(b));
        for (var i = 0; i < 3; i++)
        {
            var d = x.ElementAtOrDefault(i) - y.ElementAtOrDefault(i);
            if (d != 0) return d;
        }
        return 0;
    }

    public async Task<UpdateState> Check()
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repo}/releases/latest");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var res = await http.SendAsync(req);
            if (!res.IsSuccessStatusCode) throw new HttpRequestException($"GitHub ({(int)res.StatusCode})");
            release = JsonSerializer.Deserialize(await res.Content.ReadAsStringAsync(), ApiJson.Default.Release);
            var tag = release?.TagName ?? throw new InvalidOperationException("リリースにタグが無い");
            State = new(tag, Compare(tag, version) > 0 && tag != failed, Now, tag == failed ? $"{tag} は署名が合わなかった" : null);
        }
        catch (Exception e)
        {
            State = State with { CheckedAt = Now, Error = e.Message };
        }
        return State;
    }

    /// <summary>
    /// 新しい版を落として確かめ、msiexec を起動する。終わるのは待たない。MSI がこのサービスを止めて入れ替える。
    /// 落としているあいだに誰かがつないだら入れないので、落とし終えたところで isIdle をもう一度聞く
    /// </summary>
    public async Task<bool> Apply(Func<bool> isIdle)
    {
        if (release is not { } r || !State.Available || !isIdle()) return false;
        if (launched is { } l && l.Tag == r.TagName && DateTimeOffset.UtcNow - l.At < TimeSpan.FromHours(1)) return false;
        if (!await gate.WaitAsync(0)) return false;
        try
        {
            string Url(string name) =>
                r.Assets.FirstOrDefault(a => a.Name == name)?.Url ?? throw new InvalidOperationException($"{r.TagName} に {name} が無い");
            var dir = Path.Combine(dataDir, "updates");
            Directory.CreateDirectory(dir);
            var msi = Path.Combine(dir, $"mado-{r.TagName}.msi");
            var sigFile = msi + ".sig";
            // つないでいる人がいて前回入れられなかったときは、そのとき落としたものを使う。
            // 置いてあるものでも、署名は毎回確かめ直す
            if (!(File.Exists(msi) && File.Exists(sigFile) && await Verified(r.TagName, msi, await File.ReadAllTextAsync(sigFile))))
            {
                var sig = await http.GetStringAsync(Url("mado.msi.sig"));
                using (var res = await http.GetAsync(Url("mado.msi"), HttpCompletionOption.ResponseHeadersRead))
                {
                    res.EnsureSuccessStatusCode();
                    await using var file = File.Create(msi);
                    await res.Content.CopyToAsync(file);
                }
                if (!await Verified(r.TagName, msi, sig))
                {
                    failed = r.TagName;
                    State = State with { Available = false, Error = $"{r.TagName} の署名が合わない" };
                    File.Delete(msi);
                    File.Delete(sigFile);
                    log($"update: {r.TagName} の署名が合わないので入れない");
                    return false;
                }
                await File.WriteAllTextAsync(sigFile, sig);
            }
            if (!isIdle())
            {
                log($"update: {r.TagName} を落としたが、つないでいる人がいるので後で入れる");
                return false;
            }
            var msiLog = Path.Combine(logDir, $"msi-{r.TagName}.log");
            log($"update: {version} → {r.TagName} を入れる(msiexec。ログは {msiLog})");
            Directory.CreateDirectory(logDir);
            launch(msi, msiLog);
            launched = (r.TagName, DateTimeOffset.UtcNow);
            return true;
        }
        catch (Exception e)
        {
            State = State with { Error = e.Message };
            log($"update failed: {e.Message}");
            return false;
        }
        finally
        {
            gate.Release();
        }
    }

    async Task<bool> Verified(string tag, string msi, string sig)
    {
        string sha;
        await using (var file = File.OpenRead(msi)) sha = Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
        return Verify(Message(tag, sha), sig, publicKey);
    }

    /// <summary>入れ終わった MSI のうち、今の版より新しくないものを消す</summary>
    public void Cleanup()
    {
        var dir = Path.Combine(dataDir, "updates");
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.EnumerateFiles(dir, "mado-*.msi"))
        {
            var tag = Path.GetFileNameWithoutExtension(f)["mado-".Length..];
            if (Compare(tag, version) > 0) continue;
            try
            {
                File.Delete(f);
                File.Delete(f + ".sig");
            }
            catch (IOException) { }
        }
    }

    static string Now => DateTimeOffset.UtcNow.ToString("o");
}
