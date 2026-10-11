# mado

OIDC でログインして、ブラウザから RDP する小さなゲートウェイ。Windows のサービスとして動く。MSI で入れる。

Guacamole のようにサーバーで画面を描くのではなく、RDP は全部ブラウザの中の
[IronRDP](https://github.com/Devolutions/IronRDP)(WASM)が話す。mado がするのは、ログインの確認と、
ブラウザ ↔ RDP サーバーの中継(RDCleanPath)だけ。

```
ブラウザ ──https──> mado ──OIDC──> Entra ID などの IdP
   │  IronRDP(WASM)
   └──wss /ws(RDCleanPath)──> mado ──TCP + TLS──> RDP(既定 127.0.0.1:3389)
```

- 外に出すのは 443(画面と中継)と 80(Let's Encrypt の確認と https への案内)だけ。3389 は外に出さない
- つなぐ先は設定に書いたもの(`targets`)だけ。画面で選んだ先は、サーバーが出す使い捨てのトークンに入れて決める。ブラウザが送ってくる行き先は見ない(どこへでも行ける踏み台にしない)
- Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado には届かない
- 証明書は Let's Encrypt から自分で取って、30 日を切ったら取り直す(HTTP-01)

## 作り

| 部分 | 中身 |
| --- | --- |
| `server/` | **.NET 10(Native AOT)**。`CreateSlimBuilder` の Kestrel で、`UseWindowsService` でそのままサービスになる。OIDC・ACME・DER・RDCleanPath は手書き(ASP.NET Core の OIDC の仕組みは AOT に対応していない)。外から入れているのは Microsoft の `Microsoft.Extensions.Hosting.WindowsServices` だけ |
| `web/` | 画面。TS と [Blades CSS](https://blades.ninja/)、IronRDP の Web クライアント。**bun でビルドして exe に埋め込む**(実行時に bun はいない) |
| `installer/` | MSI(WiX v5)。サービスの登録、ファイアウォール(TCP 80 / 443)、`C:\ProgramData\mado` の権限 |

RDP との TLS は `SslStream`(Windows の SChannel)なので、RDP の自己署名証明書をそのまま受けられる。

## 使い方

1. `C:\ProgramData\mado\mado.json` に設定を書く(下)。client secret は同じフォルダの `client-secret.txt` に
2. [リリース](https://github.com/danything/mado/releases)の `mado.msi` を入れる(`msiexec /i mado.msi`)。サービス `mado` が自動で起動する

先に MSI を入れてもよい。設定が無いうちはサービスの起動が失敗するだけなので、置いてから `Restart-Service mado` する。
フォルダは MSI が SYSTEM と Administrators だけが読めるように作る(client secret とセッションの鍵が入る)。
**更新は新しい版の `mado.msi` を入れる**(古い版を外して入れ替える。設定と証明書は残る)。

```json
{
	"host": "md.example.com",
	"acme": { "email": "admin@example.com" },
	"oidc": {
		"issuer": "https://login.microsoftonline.com/<テナント ID>/v2.0",
		"client_id": "<アプリ登録のクライアント ID>",
		"client_secret_file": "client-secret.txt",
		"required_role": "admin"
	},
	"targets": [
		{ "name": "この PC", "host": "127.0.0.1" },
		{ "name": "書斎の PC", "host": "10.0.0.20", "port": 3389 }
	]
}
```

| 項目 | 中身 |
| --- | --- |
| `host` | 外から開く名前。証明書と OIDC の戻り先に使う |
| `data_dir` | 証明書・ACME のアカウント・セッションの鍵の置き場。既定は設定ファイルの隣の `data` |
| `acme.email` | Let's Encrypt に登録する連絡先。`acme.staging: true` で試験用の Let's Encrypt に |
| `oidc` | `issuer`・`client_id`・`client_secret`(または 1 行目を読む `client_secret_file`)。`required_role` を書くと、ID トークンの `roles` にそれが無い人は入れない |
| `targets` | つなぐ先(`name`・`host`・`port`。`port` の既定は 3389)。画面で選ぶ。1 つだけなら選ぶ欄は出ない。省くとこのマシン(127.0.0.1:3389)だけ |
| `listen` | 待ち受け。既定は `{ "https": 443, "http": 80, "hostname": "::" }`(IPv4 も受ける) |
| `status.port` | この PC の中からだけ見られる状態の口(既定 8788、`0` で開けない)。`GET http://127.0.0.1:8788/status` で版・つないでいる数・証明書の残り日数 |
| `tls` | `"off"` にすると TLS も ACME も使わず http だけで待ち受ける(localhost で試すとき) |

IdP には戻り先 `https://<host>/callback` を登録する。Entra ID ならアプリロールを作って割り当て、`required_role` にその値を書く。

ログは `C:\ProgramData\mado\logs\mado.log`(10 MB を超えたら `.1` に回す)。

## 開発

```sh
bun install
bun run build:web                          # 画面を dist/web に(server が埋め込む。server より先に)
dotnet run --project tests/Mado.Tests.csproj   # 試験(TUnit)
dotnet run --project server/Mado.csproj -- --config mado.dev.json   # "tls": "off" にすると http だけで試せる
bun run check                              # 画面の biome と tsc
```

手元に .NET が無ければ `mcr.microsoft.com/dotnet/sdk:10.0` のコンテナで同じことができる。exe(Native AOT)と MSI は
Windows でしか作れないので CI(`windows-latest`)で作る。

## ライセンス

AGPL-3.0。IronRDP の Web クライアントは MIT OR Apache-2.0、Blades CSS は MIT。
