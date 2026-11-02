using System.Text.Json;

namespace Mado;

/// <summary>つなぐ先の種類。RDP の PC、Intel AMT(電源と SOL)、Talos のダッシュボード(talosctl dashboard)</summary>
internal enum TargetKind { Rdp, Amt, Talos }

/// <summary>
/// つなぐ先。画面で名前を選ぶ。RDP は Port が RDP の port。
/// AMT は Port が WS-Man(16992、TLS なら 16993)で、SOL などのリダイレクトは RedirectPort(16994、TLS なら 16995)。
/// CertSha256 は AMT に TLS でつなぐとき、証明書(leaf の DER)の SHA-256 で確かめる指紋。無ければ確かめない。
/// Talos の先は Host が node、Port が Talos API(50000)で、Talos にダッシュボードの設定が入る(Talos.cs)
/// </summary>
internal sealed record Target(string Name, string Host, int Port, TargetKind Kind = TargetKind.Rdp, bool Tls = false, string? CertSha256 = null,
    TalosOptions? Talos = null)
{
    public const int AmtHttp = 16992, AmtHttps = 16993, AmtRedirect = 16994, AmtRedirectTls = 16995, TalosApi = 50000;

    public int RedirectPort => Tls ? AmtRedirectTls : AmtRedirect;

    /// <summary>画面と API に出す種類の名前</summary>
    public string Type => Kind switch { TargetKind.Amt => "amt", TargetKind.Talos => "talos", _ => "rdp" };
}

/// <summary>
/// JSON の設定ファイル。`--config &lt;path&gt;` で場所を指定する。指定が無ければ %ProgramData%\mado\mado.json を読む。
/// MSI で入れるとここに置かれ、サービスもここを読む。書き方は bun 版の v0.2 / v0.3 と同じ。
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
    int StatusPort,
    Config.UpdateOptions Update,
    int WebTransportPort = 0,
    IReadOnlyList<string>? Warnings = null)
{
    /// <summary>自動更新。CheckHours ごとに GitHub のリリースを見る。中身は Updater.cs</summary>
    public sealed record UpdateOptions(bool Enabled, int CheckHours, string Repo);
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

        var warnings = new List<string>();
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
            ReadTargets(raw, file, warnings),
            raw.Status?.Port ?? 8788,
            new UpdateOptions(raw.Update?.Enabled ?? true, raw.Update?.CheckHours ?? 6, raw.Update?.Repo ?? "danything/mado"));
        if (config.Tls == "acme" && config.Acme.Email == "") throw new ConfigException($"{file}: acme.email が要る");
        return config with { WebTransportPort = ReadWebTransport(raw, config, file), Warnings = warnings };
    }

    /// <summary>
    /// WebTransport の UDP の port。0 は使わない。書いていなければ、tls が acme のとき https と同じ port を使う。
    /// false か port 0 で止める。証明書が要るので、tls が off のときは使えない
    /// </summary>
    static int ReadWebTransport(Raw raw, Config config, string file)
    {
        var at = $"{file}: webtransport";
        int port;
        switch (raw.Webtransport)
        {
            case null:
            case { ValueKind: JsonValueKind.Null }:
                return config.Tls == "acme" ? config.Listen.Https : 0;
            case { ValueKind: JsonValueKind.False }:
                return 0;
            case { ValueKind: JsonValueKind.True }:
                port = config.Listen.Https;
                break;
            case { ValueKind: JsonValueKind.Object } o:
                if (!o.TryGetProperty("port", out var p)) port = config.Listen.Https;
                else if (!p.TryGetInt32(out port) || port is < 0 or > 65535) throw new ConfigException($"{at}.port は 0〜65535 の整数");
                break;
            default:
                throw new ConfigException($"{at} は true / false か {{ \"port\": 443 }}");
        }
        if (port != 0 && config.Tls != "acme") throw new ConfigException($"{at} は tls が acme のときだけ使える(証明書が要る)");
        return port;
    }

    static List<Target> ReadTargets(Raw raw, string file, List<string> warnings)
    {
        var dir = Path.GetDirectoryName(file)!;
        if (raw.Targets is null) return [new Target("localhost", "127.0.0.1", 3389)];
        if (raw.Targets.Count == 0) throw new ConfigException($"{file}: targets は 1 つ以上の配列");
        var seen = new HashSet<string>();
        var targets = new List<Target>();
        void Add(Target target, string at)
        {
            if (!seen.Add(target.Name)) throw new ConfigException($"{at}.name が重なっている ({target.Name})");
            targets.Add(target);
        }
        for (var i = 0; i < raw.Targets.Count; i++)
        {
            var t = raw.Targets[i];
            var at = $"{file}: targets[{i}]";
            var type = t.Type ?? "rdp";
            if (type == "talos")
            {
                Add(ReadTalosTarget(t, at, dir), at);
                continue;
            }
            if (t.Talosconfig is not null || t.Node is not null || t.Endpoints is not null || t.Talosctl is not null)
                throw new ConfigException($"{at}: talosconfig・node・endpoints・talosctl は type が talos のときだけ");
            if (string.IsNullOrEmpty(t.Host)) throw new ConfigException($"{at}.host が要る");
            var name = t.Name ?? t.Host;
            if (name == "") throw new ConfigException($"{at}.name は空でない文字列");
            switch (type)
            {
                case "rdp":
                    if (t.Tls is not null || t.CertSha256 is not null || t.Talos is not null)
                        throw new ConfigException($"{at}: tls・cert_sha256・talos は type が amt のときだけ");
                    var port = t.Port ?? 3389;
                    if (port is < 1 or > 65535) throw new ConfigException($"{at}.port は 1〜65535 の整数");
                    Add(new Target(name, t.Host, port), at);
                    break;
                case "amt":
                    // AMT の port は決まっている(WS-Man とリダイレクトの 2 つ)。tls で選ぶ
                    if (t.Port is not null) throw new ConfigException($"{at}.port は書かない(AMT は tls で 16992 / 16993 を選ぶ)");
                    var tls = t.Tls ?? false;
                    var pin = t.CertSha256 is null ? null : NormalizeFingerprint(t.CertSha256)
                        ?? throw new ConfigException($"{at}.cert_sha256 は SHA-256 の 16 進(64 文字。: や空白は無視する)");
                    if (pin is not null && !tls) throw new ConfigException($"{at}.cert_sha256 は tls が true のときだけ");
                    Add(new Target(name, t.Host, tls ? Target.AmtHttps : Target.AmtHttp, TargetKind.Amt, tls, pin), at);
                    // v0.13 の形(AMT の先の中の talos)。AMT の認証は要らないので、別の talos の先として一覧に出す
                    if (t.Talos is { } old)
                    {
                        var talosName = $"{name} のダッシュボード";
                        Add(TalosTarget(talosName, ReadTalos(old.Talosconfig, old.Node, old.Endpoints, old.Talosctl, $"{at}.talos", dir)), at);
                        warnings.Add($"{at}.talos は古い形。「{talosName}」(type が talos の先)として読んだ。" +
                            "{ \"type\": \"talos\", \"talosconfig\": …, \"node\": … } の先に書き直して(docs/talos.md)");
                    }
                    break;
                default:
                    throw new ConfigException($"{at}.type は rdp・amt・talos のどれか");
            }
        }
        return targets;
    }

    static Target TalosTarget(string name, TalosOptions o) => new(name, o.Node, Target.TalosApi, TargetKind.Talos, Talos: o);

    /// <summary>type が talos の先。host・port・tls・cert_sha256 は書かない(つなぐのは talosctl で、行き先は node と endpoints)</summary>
    static Target ReadTalosTarget(RawTarget t, string at, string dir)
    {
        if (t.Host is not null || t.Port is not null || t.Tls is not null || t.CertSha256 is not null || t.Talos is not null)
            throw new ConfigException($"{at}: type が talos の先には host・port・tls・cert_sha256・talos を書かない(node と endpoints に書く)");
        if (string.IsNullOrEmpty(t.Name)) throw new ConfigException($"{at}.name が要る");
        return TalosTarget(t.Name, ReadTalos(t.Talosconfig, t.Node, t.Endpoints, t.Talosctl, at, dir));
    }

    /// <summary>
    /// talos の先の設定。talosctl に渡すのはこの値だけで、ブラウザからは何も足せない。
    /// node と endpoints はアドレスかホスト名だけ(- で始まる値は talosctl のフラグに読まれるので弾く)。endpoints の既定は node
    /// </summary>
    static TalosOptions ReadTalos(string? talosconfig, string? node, List<string>? endpointList, string? talosctl, string at, string dir)
    {
        if (string.IsNullOrEmpty(talosconfig)) throw new ConfigException($"{at}.talosconfig が要る(DPAPI で保護した talosconfig の場所)");
        if (string.IsNullOrEmpty(node)) throw new ConfigException($"{at}.node が要る");
        if (!TalosOptions.IsHost(node)) throw new ConfigException($"{at}.node はアドレスかホスト名 ({node})");
        List<string> endpoints = endpointList is null ? [node] : [.. endpointList];
        if (endpoints.Count == 0) throw new ConfigException($"{at}.endpoints は 1 つ以上の配列");
        foreach (var e in endpoints)
            if (!TalosOptions.IsHost(e)) throw new ConfigException($"{at}.endpoints はアドレスかホスト名の配列 ({e})");
        if (talosctl == "") throw new ConfigException($"{at}.talosctl は空でない文字列(書かなければ PATH から探す)");
        return new TalosOptions(
            Path.GetFullPath(talosconfig, dir), node, endpoints,
            talosctl is null ? null : Path.GetFullPath(talosctl, dir));
    }

    /// <summary>指紋を大文字の 16 進 64 文字にする。: や空白は無視する。形が違えば null</summary>
    internal static string? NormalizeFingerprint(string s)
    {
        var hex = new string([.. s.Where(c => c is not (':' or ' ' or '-'))]).ToUpperInvariant();
        return hex.Length == 64 && hex.All(Uri.IsHexDigit) ? hex : null;
    }

    /// <summary>名前で RDP のつなぐ先を探す。ほかの種類や無い名前は null</summary>
    public Target? Rdp(string? name) => Targets.FirstOrDefault(t => t.Name == name && t.Kind == TargetKind.Rdp);

    /// <summary>名前で AMT のつなぐ先を探す。RDP の先や無い名前は null</summary>
    public Target? Amt(string? name) => Targets.FirstOrDefault(t => t.Name == name && t.Kind == TargetKind.Amt);

    /// <summary>名前で Talos のダッシュボードの先を探す。ほかの種類や無い名前は null</summary>
    public Target? Talos(string? name) => Targets.FirstOrDefault(t => t.Name == name && t.Kind == TargetKind.Talos);

    /// <summary>外から見た URL の起点。普段は https で、tls が off なら http とポート</summary>
    public string Origin => Tls == "off"
        ? $"http://{Host}{(Listen.Http == 80 ? "" : $":{Listen.Http}")}"
        : $"https://{Host}{(Listen.Https == 443 ? "" : $":{Listen.Https}")}";

    /// <summary>
    /// http で来た要求を送り直す先。origin に要求のパスとクエリ(エンコードしたもの)を付ける。
    /// パスとクエリは要求から来るので、組み立てた URL のスキーム・ホスト・ポートが origin と同じかを確かめ、
    /// 違えば(`//evil.example` のようなパスで外を指したら)origin の `/` にする
    /// </summary>
    public static string SameOrigin(string origin, string pathAndQuery)
    {
        var home = new Uri(origin);
        if (Uri.TryCreate(home, pathAndQuery, out var target)
            && target.Scheme == home.Scheme && target.Host == home.Host && target.Port == home.Port)
            return target.AbsoluteUri;
        return new Uri(home, "/").AbsoluteUri;
    }

    // ファイルの形。キーは snake_case で、MadoJson で読む
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
        public RawUpdate? Update { get; set; }
        /// <summary>true / false か { "port": 443 }</summary>
        public JsonElement? Webtransport { get; set; }
    }
    internal sealed class RawUpdate { public bool? Enabled { get; set; } public int? CheckHours { get; set; } public string? Repo { get; set; } }
    internal sealed class RawListen { public int? Https { get; set; } public int? Http { get; set; } public string? Hostname { get; set; } }
    internal sealed class RawAcme { public string? Email { get; set; } public bool? Staging { get; set; } }
    internal sealed class RawOidc
    {
        public string? Issuer { get; set; }
        public string? ClientId { get; set; }
        public string? ClientSecret { get; set; }
        /// <summary>client_secret をこのファイルの 1 行目から読む</summary>
        public string? ClientSecretFile { get; set; }
        public string? RequiredRole { get; set; }
    }
    internal sealed class RawTarget
    {
        public string? Name { get; set; }
        /// <summary>rdp(既定)・amt・talos</summary>
        public string? Type { get; set; }
        public string? Host { get; set; }
        public int? Port { get; set; }
        /// <summary>AMT だけ。true で 16993 / 16995(TLS)</summary>
        public bool? Tls { get; set; }
        public string? CertSha256 { get; set; }
        /// <summary>v0.13 の形(AMT の先の中の Talos のダッシュボード)。読むときに talos の先にする</summary>
        public RawTalos? Talos { get; set; }
        /// <summary>talos だけ。DPAPI で保護した talosconfig。相対なら設定ファイルの場所から</summary>
        public string? Talosconfig { get; set; }
        /// <summary>talos だけ</summary>
        public string? Node { get; set; }
        /// <summary>talos だけ。既定は node</summary>
        public List<string>? Endpoints { get; set; }
        /// <summary>talos だけ。talosctl.exe の場所。無ければ PATH から探す</summary>
        public string? Talosctl { get; set; }
    }
    /// <summary>v0.13 の targets[].talos</summary>
    internal sealed class RawTalos
    {
        public string? Talosconfig { get; set; }
        public string? Node { get; set; }
        public List<string>? Endpoints { get; set; }
        /// <summary>talosctl.exe の場所。無ければ PATH から探す</summary>
        public string? Talosctl { get; set; }
    }
    internal sealed class RawStatus { public int? Port { get; set; } }
}

internal sealed class ConfigException(string message) : Exception(message);
