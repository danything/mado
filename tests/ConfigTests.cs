namespace Mado.Tests;

public class ConfigTests
{
    const string Base = """
        "host": "md.example.com",
        "acme": { "email": "a@example.com" },
        "oidc": { "issuer": "https://idp.example.com", "client_id": "id", "client_secret": "s" }
        """;

    static Config Load(string json, string name = "mado.json")
    {
        var dir = Directory.CreateTempSubdirectory("mado-config-").FullName;
        var file = Path.Combine(dir, name);
        File.WriteAllText(file, json);
        return Config.Load(["--config", file]);
    }

    [Test]
    public async Task targets_を省くとこのマシンだけ()
    {
        var c = Load($"{{ {Base} }}");
        await Assert.That(c.Targets.Count).IsEqualTo(1);
        await Assert.That(c.Targets[0]).IsEqualTo(new Target("localhost", "127.0.0.1", 3389));
        await Assert.That(c.Origin).IsEqualTo("https://md.example.com");
        await Assert.That(c.StatusPort).IsEqualTo(8788);
    }

    [Test]
    public async Task name_の既定は_host_で_port_の既定は_3389()
    {
        var c = Load($$"""{ {{Base}}, "targets": [{ "host": "10.0.0.20" }, { "name": "b", "host": "10.0.0.21", "port": 3390 }] }""");
        await Assert.That(c.Targets[0]).IsEqualTo(new Target("10.0.0.20", "10.0.0.20", 3389));
        await Assert.That(c.Targets[1]).IsEqualTo(new Target("b", "10.0.0.21", 3390));
    }

    [Test]
    [Arguments("\"targets\": []", "1 つ以上")]
    [Arguments("\"targets\": [{ \"name\": \"a\" }]", "host が要る")]
    [Arguments("\"targets\": [{ \"host\": \"x\", \"port\": 70000 }]", "1〜65535")]
    [Arguments("\"targets\": [{ \"host\": \"x\" }, { \"host\": \"x\" }]", "重なっている")]
    public async Task targets_の間違いは起動時に止める(string bad, string message)
    {
        var e = Assert.Throws<ConfigException>(() => Load($"{{ {Base}, {bad} }}"));
        await Assert.That(e.Message).Contains(message);
    }

    [Test]
    public async Task 古い_TOML_には_JSON_に変わったと言う()
    {
        var e = Assert.Throws<ConfigException>(() => Load("host = \"x\"", "mado.toml"));
        await Assert.That(e.Message).Contains("JSON");
    }

    [Test]
    public async Task 読めない_JSON_はファイル名つきで止める()
    {
        var e = Assert.Throws<ConfigException>(() => Load("{ host: ", "broken.json"));
        await Assert.That(e.Message).Contains("broken.json");
    }

    [Test]
    public async Task client_secret_file_の_1_行目を読む()
    {
        var dir = Directory.CreateTempSubdirectory("mado-config-").FullName;
        File.WriteAllText(Path.Combine(dir, "secret.txt"), "s3cret\nignored\n");
        var file = Path.Combine(dir, "mado.json");
        File.WriteAllText(file, """
            { "host": "h", "acme": { "email": "a@b" },
              "oidc": { "issuer": "https://i", "client_id": "c", "client_secret_file": "secret.txt" } }
            """);
        await Assert.That(Config.Load(["--config", file]).Oidc.ClientSecret).IsEqualTo("s3cret");
    }
}
