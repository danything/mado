using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mado;

// AOT では反射で JSON を読み書きできないので、使う型をここに並べてソース生成させる

/// <summary>設定ファイル(snake_case)</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true)]
[JsonSerializable(typeof(Config.Raw))]
internal sealed partial class MadoJson : JsonSerializerContext;

/// <summary>API の返事・署名付きの値・外の API(OIDC、ACME、GitHub)。名前はそのまま(camelCase / snake_case を型で書く)</summary>
[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(SessionInfo))]
[JsonSerializable(typeof(TokenInfo))]
[JsonSerializable(typeof(LoginRequired))]
[JsonSerializable(typeof(Status))]
[JsonSerializable(typeof(Release))]
[JsonSerializable(typeof(UpdateResult))]
[JsonSerializable(typeof(User))]
[JsonSerializable(typeof(Pending))]
[JsonSerializable(typeof(RelayToken))]
[JsonSerializable(typeof(OidcDiscovery))]
[JsonSerializable(typeof(OidcToken))]
[JsonSerializable(typeof(Jwks))]
[JsonSerializable(typeof(JwtHeader))]
[JsonSerializable(typeof(JwtClaims))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(Dictionary<string, JsonElement>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(Dictionary<string, object>))]
[JsonSerializable(typeof(object[]))]
[JsonSerializable(typeof(string[]))]
internal sealed partial class ApiJson : JsonSerializerContext;

internal sealed record SessionInfo(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("targets")] string[] Targets,
    [property: JsonPropertyName("ws")] string Ws);

internal sealed record TokenInfo([property: JsonPropertyName("token")] string Token);

internal sealed record LoginRequired([property: JsonPropertyName("login")] string Login);

internal sealed record Status(
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("origin")] string Origin,
    [property: JsonPropertyName("startedAt")] string StartedAt,
    [property: JsonPropertyName("sessions")] int Sessions,
    [property: JsonPropertyName("certDaysLeft")] int? CertDaysLeft,
    [property: JsonPropertyName("update")] UpdateState Update);

internal sealed record UpdateResult(
    [property: JsonPropertyName("started")] bool Started,
    [property: JsonPropertyName("state")] UpdateState State);
