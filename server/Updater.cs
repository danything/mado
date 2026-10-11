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
/// 新しい版を入れる。GitHub のリリースの最新を見て、今より新しければ mado.msi と mado.msi.sig を落とし、
/// **署名を確かめてから** msiexec に渡す。入れ替え(サービスを止める・古い版を外す・新しい版を入れて起動する)は
/// MSI のメジャー アップグレードがやる。
///
/// 署名は CI(release.yml)が ECDSA P-256 の秘密鍵(GitHub の secret MADO_SIGNING_KEY)で `mado &lt;タグ&gt; &lt;MSI の SHA-256&gt;` に
/// 付けたもので、確かめる公開鍵は下の PublicKey。タグも署名の中なので、古い版を「最新」と偽って戻させることもできない
/// (今より新しい版しか受けない。MSI も古い版では上書きしない)。入れるのは誰もつないでいないときだけ。
/// </summary>
internal sealed class Updater(string repo, string version, string dataDir, HttpClient http, Action<string> log)
{
    /// <summary>release.yml の秘密鍵と対になる公開鍵(SubjectPublicKeyInfo の base64)</summary>
    internal const string PublicKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExPX0Nm0/E8OPtFh/7BxycvGRy2DSjjnAJBTGRgFKpSngFDwF7QRI8d6cWHRD/WttcrUHR0Ci7Kn3uidHi0SMyQ==";

    public UpdateState State { get; private set; } = new(null, false, null, null);
    Release? release;
    /// <summary>署名が合わなかった版。次の版が出るまで取り直さない</summary>
    string? failed;
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
    /// 新しい版を落として確かめ、msiexec を起動する(終わりは待たない。MSI がこのサービスを止めて入れ替える)。
    /// isIdle は落とし終えた直前にもう一度聞く(落としているあいだに誰かがつないだら入れない)
    /// </summary>
    public async Task<bool> Apply(Func<bool> isIdle)
    {
        if (release is not { } r || !State.Available || !isIdle()) return false;
        if (!await gate.WaitAsync(0)) return false;
        try
        {
            string Url(string name) =>
                r.Assets.FirstOrDefault(a => a.Name == name)?.Url ?? throw new InvalidOperationException($"{r.TagName} に {name} が無い");
            var dir = Path.Combine(dataDir, "updates");
            Directory.CreateDirectory(dir);
            var msi = Path.Combine(dir, $"mado-{r.TagName}.msi");
            var sig = await http.GetStringAsync(Url("mado.msi.sig"));
            using (var res = await http.GetAsync(Url("mado.msi"), HttpCompletionOption.ResponseHeadersRead))
            {
                res.EnsureSuccessStatusCode();
                await using var file = File.Create(msi);
                await res.Content.CopyToAsync(file);
            }
            string sha;
            await using (var file = File.OpenRead(msi)) sha = Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
            if (!Verify(Message(r.TagName, sha), sig))
            {
                failed = r.TagName;
                State = State with { Available = false, Error = $"{r.TagName} の署名が合わない" };
                File.Delete(msi);
                log($"update: {r.TagName} の署名が合わないので入れない");
                return false;
            }
            if (!isIdle())
            {
                log($"update: {r.TagName} を落としたが、つないでいる人がいるので後で入れる");
                return false;
            }
            var msiLog = Path.Combine(Path.GetDirectoryName(dataDir)!, "logs", $"msi-{r.TagName}.log");
            log($"update: {version} → {r.TagName} を入れる(msiexec。ログは {msiLog})");
            Process.Start(new ProcessStartInfo("msiexec.exe")
            {
                ArgumentList = { "/i", msi, "/qn", "/norestart", "/l*v", msiLog },
                UseShellExecute = false,
            });
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

    /// <summary>入れ終わった古い MSI を消す(今の版より古いもの)</summary>
    public void Cleanup()
    {
        var dir = Path.Combine(dataDir, "updates");
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.EnumerateFiles(dir, "mado-*.msi"))
        {
            var tag = Path.GetFileNameWithoutExtension(f)["mado-".Length..];
            if (Compare(tag, version) <= 0)
                try { File.Delete(f); } catch (IOException) { }
        }
    }

    static string Now => DateTimeOffset.UtcNow.ToString("o");
}
