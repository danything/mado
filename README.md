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
- つなぐ先は設定の 1 か所だけ。ブラウザが送ってくる行き先は見ない(どこへでも行ける踏み台にしない)
- Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado には届かない
- 証明書は Let's Encrypt から自分で取って、30 日を切ったら取り直す(HTTP-01)
- 実行時の依存は無い。OIDC・ACME・DER は `fetch` と WebCrypto と `node:crypto` で書いてある。
  npm から入れるのは画面の IronRDP の 2 つだけ(どちらも依存なし。exe に取り込むので devDependencies)

## 使い方

[リリース](https://github.com/danything/mado/releases)の `mado.exe` を置き、同じフォルダに `mado.toml` を書いて起動する。

```toml
host = "md.example.com"          # 外から開く名前(証明書と OIDC の戻り先に使う)
# data_dir = "data"              # 証明書・ACME のアカウント・セッションの鍵(既定は設定ファイルの隣の data)

[acme]
email = "admin@example.com"     # Let's Encrypt に登録する連絡先
# staging = true                 # 試すときは Let's Encrypt の試験用に

[oidc]
issuer = "https://login.microsoftonline.com/<テナント ID>/v2.0"
client_id = "<アプリ登録のクライアント ID>"
client_secret_file = "client-secret.txt"   # または client_secret = "..."
required_role = "admin"          # ID トークンの roles にこれが無い人は入れない(空なら確かめない)

# 既定のまま: つなぐ先と待ち受け
# [rdp]
# host = "127.0.0.1"
# port = 3389
# [listen]
# https = 443
# http = 80
# hostname = "::"
```

IdP には戻り先 `https://<host>/callback` を登録する。Entra ID ならアプリロールを作って割り当て、`required_role` にその値を書く。

起動は `mado.exe`(`--config <path>` で設定ファイルを変えられる)。サインインしなくても動くように、
タスク スケジューラで「起動時に SYSTEM で実行」に登録するとよい。設定とデータのフォルダは SYSTEM と Administrators だけが
読めるようにする(client secret とセッションの鍵が入る)。

### RDP の証明書について

Windows の RDP の自己署名証明書は鍵の用途に Digital Signature が無く、bun の TLS(BoringSSL)は ECDHE の
鍵交換でそれを拒む。そこで RDP とのあいだだけ TLS 1.2 の RSA 鍵交換に絞っている(同じマシンのループバックなので
前方秘匿性が無いことは問題にならない)。

## 開発

```sh
bun install
bun run dev        # mado.dev.toml を読んで起動(tls = "off" にすると http だけで localhost で試せる)
bun test           # 手元に RDP(127.0.0.1:3389)があれば中継の試験も走る
bun run check      # biome と tsc
bun run build      # dist/mado.exe(Windows x64 の単体 exe)
```

## ライセンス

AGPL-3.0。IronRDP の Web クライアントは MIT OR Apache-2.0。
