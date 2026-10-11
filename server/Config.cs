using System.Text.Json;

namespace Mado;

/// <summary>つなぐ先の RDP。画面で名前を選ぶ</summary>
internal sealed record Target(string Name, string Host, int Port);

/// <summary>
/// 設定ファイル(JSON)。置き場所は `--config &lt;path&gt;`、無ければ %ProgramData%\mado\mado.json
/// (MSI で入れたときの置き場所。サービスはここを読む)。書き方は v0.2 / v0.3(bun 版)と同じ。
/// </summary>
internal sealed record Config(
    string File,
    string Host,
    string DataDir,
    Config.ListenOptions Listen,
    string Tls,
    Config.AcmeOptions Acme,
    Config.OidcOptions Oidc,
    IReadOnlyList<Target> Targets,
    int StatusPort)
{
    public sealed record ListenOptions(int Https, int Http, string Hostname);
    public sealed record AcmeOptions(string Email, bool Staging);
    public sealed record OidcOptions(string Issuer, string ClientId, string ClientSecret, string RequiredRole);

    public static string DefaultPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "mado", "mado.json");

    public static Config Load(string[] args)
    {
        var i = Array.IndexOf(args, "--config");
        var file = Path.GetFullPath(i >= 0 && i + 1 < args.Length ? args[i + 1] : DefaultPath);
        if (file.EndsWith(".toml", StringComparison.OrdinalIgnoreCase))
            throw new ConfigException($"{file}: 設定は v0.2 から JSON(mado.json)。README の「使い方」の形に書き直して");
        Raw raw;
        try
        {
            raw = JsonSerializer.Deserialize(System.IO.File.ReadAllText(file), MadoJson.Default.Raw)
                ?? throw new ConfigException($"{file}: 空");
        }
        catch (JsonException e)
        {
            throw new ConfigException($"{file}: JSON として読めない ({e.Message})");
        }
        var dir = Path.GetDirectoryName(file)!;
        string Need(string? v, string name) =>
            string.IsNullOrEmpty(v) ? throw new ConfigException($"{file}: {name} が要る") : v;

        var o = raw.Oidc ?? new RawOidc();
        var secret = o.ClientSecret;
        if (string.IsNullOrEmpty(secret) && !string.IsNullOrEmpty(o.ClientSecretFile))
            secret = System.IO.File.ReadLines(Path.GetFullPath(o.ClientSecretFile, dir)).FirstOrDefault();
        var tls = raw.Tls ?? "acme";
        if (tls is not ("acme" or "off")) throw new ConfigException($"{file}: tls は acme か off");

        var config = new Config(
            file,
            Need(raw.Host, "host"),
            Path.GetFullPath(raw.DataDir ?? "data", dir),
            new ListenOptions(raw.Listen?.Https ?? 443, raw.Listen?.Http ?? 80, raw.Listen?.Hostname ?? "::"),
            tls,
            new AcmeOptions(raw.Acme?.Email ?? "", raw.Acme?.Staging ?? false),
            new OidcOptions(
                Need(o.Issuer, "oidc.issuer"),
                Need(o.ClientId, "oidc.client_id"),
                Need(secret, "oidc.client_secret または oidc.client_secret_file"),
                o.RequiredRole ?? ""),
            ReadTargets(raw, file),
            raw.Status?.Port ?? 8788);
        if (config.Tls == "acme" && config.Acme.Email == "") throw new ConfigException($"{file}: acme.email が要る");
        return config;
    }

    static List<Target> ReadTargets(Raw raw, string file)
    {
        if (raw.Targets is null) return [new Target("localhost", "127.0.0.1", 3389)];
        if (raw.Targets.Count == 0) throw new ConfigException($"{file}: targets は 1 つ以上の配列");
        var seen = new HashSet<string>();
        return [.. raw.Targets.Select((t, i) =>
        {
            var at = $"{file}: targets[{i}]";
            if (string.IsNullOrEmpty(t.Host)) throw new ConfigException($"{at}.host が要る");
            var name = t.Name ?? t.Host;
            if (name == "") throw new ConfigException($"{at}.name は空でない文字列");
            var port = t.Port ?? 3389;
            if (port is < 1 or > 65535) throw new ConfigException($"{at}.port は 1〜65535 の整数");
            if (!seen.Add(name)) throw new ConfigException($"{at}.name が重なっている ({name})");
            return new Target(name, t.Host, port);
        })];
    }

    /// <summary>外から見た URL の起点(https、tls = off なら http + ポート)</summary>
    public string Origin => Tls == "off"
        ? $"http://{Host}{(Listen.Http == 80 ? "" : $":{Listen.Http}")}"
        : $"https://{Host}{(Listen.Https == 443 ? "" : $":{Listen.Https}")}";

    // --- ファイルの形(snake_case。MadoJson で読む) ------------------------------------------------
    internal sealed class Raw
    {
        public string? Host { get; set; }
        public string? DataDir { get; set; }
        public string? Tls { get; set; }
        public RawListen? Listen { get; set; }
        public RawAcme? Acme { get; set; }
        public RawOidc? Oidc { get; set; }
        public List<RawTarget>? Targets { get; set; }
        public RawStatus? Status { get; set; }
    }
    internal sealed class RawListen { public int? Https { get; set; } public int? Http { get; set; } public string? Hostname { get; set; } }
    internal sealed class RawAcme { public string? Email { get; set; } public bool? Staging { get; set; } }
    internal sealed class RawOidc
    {
        public string? Issuer { get; set; }
        public string? ClientId { get; set; }
        public string? ClientSecret { get; set; }
        /// <summary>client_secret の代わりにファイルから読む(1 行目)</summary>
        public string? ClientSecretFile { get; set; }
        public string? RequiredRole { get; set; }
    }
    internal sealed class RawTarget { public string? Name { get; set; } public string? Host { get; set; } public int? Port { get; set; } }
    internal sealed class RawStatus { public int? Port { get; set; } }
}

internal sealed class ConfigException(string message) : Exception(message);
