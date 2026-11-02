# Intel AMT(電源と SOL)

mado は RDP の PC のほかに、Intel AMT(vPro)の機械を `targets` に並べられる。今できるのは電源の状態を見ることと電源の操作、SOL(Serial over LAN)の端末。
KVM、IDE-R などはまだ無い。

```
ブラウザ ──https──> mado
   │  AMT のクライアント(TS、web/amt/)
   ├──POST /api/amt/<名前>/wsman(WS-Man の SOAP、Digest)──> mado ──http(s)──> AMT :16992 / 16993 /wsman
   └──wss /ws/amt(リダイレクトのバイト列)──────────────────> mado ──TCP(+ TLS)──> AMT :16994 / 16995
```

## 設定

```json
"targets": [
  { "name": "この PC", "host": "127.0.0.1" },
  { "name": "Z440(AMT)", "type": "amt", "host": "10.10.0.3" }
]
```

| 項目          | 内容                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | `"amt"`。書かなければ `"rdp"`                                                                                                               |
| `host`        | AMT のアドレス(OS ではなく AMT に割り当てたもの。OS と同じアドレスを共有する設定なら OS のアドレス)                                         |
| `tls`         | `true` で TLS(WS-Man 16993、リダイレクト 16995)。既定は `false`(16992 と 16994)。`port` は書かない                                          |
| `cert_sha256` | `tls` のとき、AMT の証明書(leaf の DER)の SHA-256。書けば一致しない相手にはつながない。書かなければ確かめない(AMT の証明書はふつう自己署名) |

AMT 側では、MEBx か AMT の Web(`http://<AMT>:16992/`)で、ネットワークのアクセスと SOL(「SOL / IDE-R」の「SOL」)を有効にしておく。

## 使い方

1. 一覧で種類が `AMT` の先を選ぶ。欄が「AMT のユーザー名」「AMT のパスワード」に変わる。ユーザー名の既定は `admin`
2. 「開く」で、電源の状態を読む。ユーザー名かパスワードが違えばここで止まる(AMT は続けて間違えると締め出すので、1 回の操作で試すのは 1 度だけ)
3. 電源: 状態(オン(S0)、オフ(S5) など)と、操作のボタン。押すと確かめる窓が出る。OS を止めない操作(リセット・電源の入れ直し・強制電源オフ)は戻せない操作として赤い字になり、窓では「取消」が選ばれている
   - 電源オン(PowerState 2)、リセット(10)、電源の入れ直し(5)、強制電源オフ(8)
   - OS のシャットダウン(12)、OS の再起動(14)は、AMT がリクエストできると答えたときだけ出る(OS 側の対応が要る)
   - 押せるボタンは AMT が返す `AvailableRequestedPowerStates` に従う。状態は 15 秒ごとに読み直す
4. 「SOL に接続」で端末(xterm.js)を開く。キー入力はそのまま送る。「SOL を切断」「閉じる」で終える

ユーザー名は RDP と同じく、つなぐ先ごとにブラウザ(localStorage)に覚える。パスワードは覚えない(ブラウザのパスワードの保存は使える)。

### Talos のコンソールを見る

AMT の SOL は、OS からは PCI のシリアル(lspci で「KT Controller」)に見える。Linux はこれを `ttyS4` などにすることが多く、`ttyS0` とは限らない。
`talosctl dmesg | grep -i ttyS` で KT Controller がどの `ttyS` かを確かめ、Talos のカーネル引数の `console=` をそれに合わせる(例 `console=ttyS0,115200`)。
速さ(115200)は OS 側の設定で、AMT の SOL には関係しない。カーネルのメッセージは `console=` に書いたすべてに出るが、`/dev/console` は最後に書いたものになる。

## しくみ

### パスワードは mado に届かない

WS-Man もリダイレクトも、AMT の認証は HTTP Digest(MD5、qop=auth)。Digest の応答はブラウザが計算する(`web/amt/digest.ts`。MD5 は WebCrypto に無いので `web/rdp/crypto.ts` の実装を使う)。
mado に届くのは計算した応答だけで、パスワードは含まれない。Basic 認証(パスワードがそのまま流れる)は、AMT が使えると言っても使わない。

### WS-Man(電源)

- `POST /api/amt/<名前>/wsman`。mado はログイン(Cookie)と Origin を確かめ、名前が設定の AMT の先(`type: "amt"`)のときだけ、その AMT の `/wsman` に本文を送る。ブラウザが宛先のアドレスや道を指定することはできない
- Authorization はそのまま AMT に渡す。AMT の `WWW-Authenticate` は `x-amt-authenticate` に移して返す(`WWW-Authenticate` のまま 401 を返すと、ブラウザが自分のログインの窓を出すため)
- 本文は 64KB、返事は 4MB まで。30 秒で打ち切る
- 電源の操作(RequestPowerStateChange)は、誰がどの PowerState を頼んだかを mado.log に残す
- 封筒は `web/amt/wsman.ts`。状態は `CIM_AssociatedPowerManagementService` を Enumerate / Pull して `PowerState` と `AvailableRequestedPowerStates` を読み、操作は `CIM_PowerManagementService` の `RequestPowerStateChange`

### SOL(リダイレクト)

- `/ws/amt` の WebSocket。最初に `/api/token` の使い捨てのトークン(60 秒、1 度だけ)を 1 行(`\n` まで)で送る。トークンの中の先が AMT のときだけ、その AMT の 16994(TLS なら 16995)に TCP でつなぎ、あとはバイト列をそのまま流す
- RDP の中継(`/ws`、`/wt`)は RDP の先だけ、AMT の中継は AMT の先だけにつなぐ。トークンを別の種類の中継に出してもつながらない
- リダイレクトのプロトコル(StartRedirectionSession、Digest の AuthenticateSession、SOL の開始、0x28 / 0x2A のデータ、2 秒ごとの生存確認)はブラウザが話す(`web/amt/redirect.ts`)。
  形は Intel の [Device Management Toolkit の UI Toolkit](https://github.com/device-management-toolkit/ui-toolkit)(`src/core/AMTRedirector.ts`、Apache-2.0)と MeshCentral に合わせて自分で書いた。コードは写していない。端末の文字の処理は xterm.js に任せるので、UI Toolkit の `TerminalDataProcessor` は使わない
- SOL は WebSocket だけを使う。文字の端末は量が小さく、WebTransport の利点(損失に強い)が効かないため
- SOL でつないでいる間は接続として数え、その間は自動更新しない

## ネットワークとセキュリティ

- AMT の port(16992〜16995)はルーターで外に開けない。外から開けるのは今までどおり mado の TCP 443 / 80 と UDP 443 だけ
- mado の PC から AMT に届くこと。AMT は OS と NIC を共有していても、OS のファイアウォールの外で答える。mado の PC の外向きの通信を止めていれば、16992 と 16994(TLS なら 16993 と 16995)を開ける
- 誰が使えるかは mado のログイン(`required_role`)で決まり、その上で AMT のユーザー名とパスワードが要る。mado のログインだけでは AMT は操作できない
- `tls: false` の WS-Man とリダイレクトは LAN の中を平文で流れる。Digest なのでパスワードは流れないが、中身(SOL の画面とキー入力)は見える。LAN を信頼できなければ AMT で TLS を有効にして `tls: true` と `cert_sha256` を使う。
  古い AMT(9 など)の TLS は TLS 1.0 / 1.1 だけのことがあり、Windows 11 は既定でそれを使わないのでつながらない
- AMT は続けてパスワードを間違えると、しばらく受け付けなくなる。mado は 1 回の操作で 1 度しか試さない

## 試験

- `bun test web/amt`: Digest(RFC 2617 の例)、WS-Man の封筒と返事、偽の AMT(`web/amt/amt.fixture.ts`)とのリダイレクトと SOL
- `dotnet run --project tests/Mado.Tests.csproj`: 設定、WS-Man の中継(Digest を確かめる偽の AMT)、SOL の中継、トークンと先の種類
- `tools/amt-e2e/`: Linux のコンテナで mado(`tls: off`)と偽の AMT を動かし、本物の `web/amt` のクライアントで電源と SOL を試す(`e2e.ts`)。`ui.cjs` は headless の Chromium で画面を操作し、`out/` に画面を残す

```powershell
wslc network create amtnet   # 「address pool」で失敗したら --subnet 10.231.77.0/24 などを付ける
wslc run --rm -v "${PWD}:/app" -w /app oven/bun:1 bun run build:web
wslc run -d --rm --name amt --network amtnet --network-alias amt.test -v "${PWD}:/app" -w /app oven/bun:1 bun tools/amt-e2e/fake-amt.ts
wslc run -d --rm --name mado-amt --network amtnet --network-alias mado.test -v "${PWD}:/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 sh tools/amt-e2e/run.sh
wslc run --rm --network amtnet -v "${PWD}:/app" -w /app oven/bun:1 bun tools/amt-e2e/e2e.ts
wslc run --rm --network amtnet -v "${PWD}:/src" -w /tmp mcr.microsoft.com/playwright:v1.64.1-noble sh -c "npm i playwright@1.64.1 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /src/tools/amt-e2e/ui.cjs"
```

本物の AMT では試していないところ: SOL の終わり方(0x22 と 0x12 を送ってから閉じる)、TLS(16993 / 16995)、OS のシャットダウンと再起動(12 / 14)。
