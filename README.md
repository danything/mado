# mado

OIDC でログインして、ブラウザから RDP する小さなゲートウェイ。Windows に **exe 1 つ**で置く。

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
- 実行時の依存は無い。OIDC・ACME・DER は `fetch` と WebCrypto と `node:crypto` で書いてある。
  npm から入れるのは画面の IronRDP の 2 つだけ(どちらも依存なし。exe に取り込むので devDependencies)

## 使い方

[リリース](https://github.com/danything/mado/releases)の `mado.exe` を置き、同じフォルダに `mado.json` を書いて起動する。

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
| `listen` | 待ち受け。既定は `{ "https": 443, "http": 80, "hostname": "::" }` |
| `tls` | `"off"` にすると TLS も ACME も使わず http だけで待ち受ける(localhost で試すとき) |

IdP には戻り先 `https://<host>/callback` を登録する。Entra ID ならアプリロールを作って割り当て、`required_role` にその値を書く。

起動は `mado.exe`(`--config <path>` で設定ファイルを変えられる)。サインインしなくても動くように、
タスク スケジューラで「起動時に SYSTEM で実行」に登録するとよい。設定とデータのフォルダは SYSTEM と Administrators だけが
読めるようにする(client secret とセッションの鍵が入る)。

画面の見た目は [Blades CSS](https://blades.ninja/)(Pico CSS の後継)。ライト / ダークは OS の設定に合わせる。
### RDP の証明書について

Windows の RDP の自己署名証明書は鍵の用途に Digital Signature が無く、bun の TLS(BoringSSL)は ECDHE の
鍵交換でそれを拒む。そこで RDP とのあいだだけ TLS 1.2 の RSA 鍵交換に絞っている。前方秘匿性が無いのは
mado と RDP のあいだ(同じマシンか LAN の中)だけで、ブラウザと mado のあいだは普通の TLS 1.3。

## 開発

```sh
bun install
bun run dev        # mado.dev.json を読んで起動("tls": "off" にすると http だけで localhost で試せる)
bun test           # 手元に RDP(127.0.0.1:3389)があれば中継の試験も走る
bun run check      # biome と tsc
bun run build      # dist/mado.exe(Windows x64 の単体 exe)
```

## ライセンス

AGPL-3.0。IronRDP の Web クライアントは MIT OR Apache-2.0、Blades CSS は MIT。
