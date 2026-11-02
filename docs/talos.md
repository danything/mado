# Talos のダッシュボード

Talos のノードを、つなぐ先の一覧に `"type": "talos"` の先として並べ、`talosctl dashboard` を開ける。
mado が mado の PC の上で talosctl を擬似端末(Windows の ConPTY)で動かし、その画面とキー入力を WebSocket で中継する。
画面は AMT の SOL と同じ見た目の端末(xterm.js)。SOL ではカーネルの文字しか見えないが、ダッシュボードなら CPU・メモリ・サービス・ログが見られる。
鍵(talosconfig)は mado の PC に置くので、AMT と違って画面で入れるものは無い。

```
ブラウザ ──wss /ws/talos(画面とキー入力)──> mado ──ConPTY──> talosctl.exe dashboard ──Talos API(50000、os:operator)──> ノード
                                              └─名前付きパイプ(talosconfig)─┘
```

## 設定

```json
"targets": [
  { "name": "Z440(AMT)", "type": "amt", "host": "10.10.0.3" },
  {
    "name": "Z440(Talos)",
    "type": "talos",
    "talosconfig": "talosconfig.dpapi",
    "node": "10.10.0.4",
    "endpoints": ["10.10.0.4"],
    "talosctl": "bin/talosctl.exe"
  }
]
```

| 項目          | 内容                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`        | 一覧に出す名前。要る                                                                                                       |
| `type`        | `"talos"`                                                                                                                  |
| `talosconfig` | DPAPI で保護した talosconfig(下の「鍵の扱い」)。相対なら mado.json の場所から。役割は `os:operator` にする                 |
| `node`        | ダッシュボードで見るノード(`--nodes`)。アドレスかホスト名                                                                  |
| `endpoints`   | Talos API の入口(`--endpoints`)。既定は `[node]`                                                                           |
| `talosctl`    | `talosctl.exe` の場所。相対なら mado.json の場所から。書かなければサービスの `PATH` から探す。無ければ開くときに失敗を返す |

`host`・`port`・`tls`・`cert_sha256` は書かない(行き先は `node` と `endpoints`)。値の形が違えば起動のときに止まる(`-` で始まる値は talosctl のフラグと読まれるので受け付けない)。

### v0.13 の形から移す

v0.13 では AMT の先の中に `"talos": { … }` を書いていた。今の mado もこの形を読み、AMT の先とは別に「`<AMT の先の名前>` のダッシュボード」という talos の先を一覧に足す(起動のときに mado.log に「古い形」と書く)。
上の形に書き直すと、その名前は好きに付けられる。

v0.13 までの mado は `"type": "talos"` を知らず、起動のときに止まる。mado.json を書き直すのは、mado を v0.14 以降に上げてからにする。

## 使い方

1. 一覧で種類が「Talos・ダッシュボード」の先を選ぶ。ユーザー名とパスワードの欄は消え、ボタンが「開く」になる
2. 「開く」を押すと、すぐ画面いっぱいの端末に `talosctl dashboard` が出る。上の常に出ているバーに名前・種類・期限の知らせ・「シャットダウン」「再起動」・「閉じる」
   - 端末の大きさは窓に合わせ、変えると talosctl にも伝える(ConPTY の大きさを変える)
   - キーはそのまま talosctl に届く。F1〜F4 で画面を切り替え、`q` か Ctrl+C で終わる
3. talosctl が終わると、端末に終わった理由(「ダッシュボードを終了しました」、失敗なら終了コードと次にすること)が出て、バーに「もう一度開く」が出る(焦点を置くので Enter でも開き直せる)。「閉じる」で一覧に戻る
4. 「シャットダウン」「再起動」は Talos に止める準備(cordon・drain・サービスの停止)をさせてから電源を切る・再起動する(`talosctl shutdown` / `reboot`)。AMT の強制電源オフ・強制再起動と違い、ノードの中を壊さない
   - AMT の電源のボタンと同じく 2 回押しで確定する。1 回目で文が「もう一度押すと再起動」に変わり(赤い字)、3 秒以内にもう一度押すと頼む。押さなければ戻る。ダブルクリック(0.4 秒以内)とキーの押しっぱなしは 2 回目とみなさない(`web/two-press.ts`。AMT と共通)
   - 結果はバーの状態の文に出る(「再起動を受け付けました」、失敗なら talosctl が最後に書いた行。鍵に権限が無ければ setup.ps1 を流し直すよう出す)。止まり始めるとダッシュボードは届かなくなる
5. talosconfig の証明書の期限が 14 日を切ると、バーに「Talos の証明書はあと N 日で切れます」と出る(切れたら「期限が切れています」)

## しくみ

- `/ws/talos` の WebSocket。`/ws/amt` と同じく、Origin とログイン(Cookie)を確かめ、最初のテキストのメッセージ `{"token": "…", "cols": 120, "rows": 40}` の `token` が `/api/token` の使い捨てのトークン(60 秒、1 度だけ、同じログインのもの)のときだけ続ける。
  トークンの中の先が talos の先のときだけ動かす(RDP や AMT の先のトークンでは動かさない)
- 動かすコマンドはいつも `talosctl --talosconfig <パイプ> --nodes <node> --endpoints <endpoints> dashboard` で、値は全部 mado.json から来る(`server/Talos.cs` の `TalosCommand`)。
  ブラウザが送れるのは端末の大きさとキー入力だけで、コマンドや引数は選べない
- あとはバイナリのメッセージが端末の入出力、テキストの `{"cols": …, "rows": …}` が大きさの変更。talosctl が終わると mado は `exited <終了コード>` の理由で閉じる。ブラウザが閉じれば talosctl を止める
- 擬似端末は ConPTY(`CreatePseudoConsole`)を P/Invoke(`LibraryImport`。Native AOT で動く)で直接呼ぶ(`server/ConPty.cs`)。
  talosctl は「閉じたら中を全部止める」ジョブに入れてから動かすので、mado が落ちても talosctl は残らない
- 同時に動かすのは 4 つまで。開いている間は接続として数え、その間は自動更新しない
- 電源の操作は `POST /api/talos/<名前>/shutdown` と `/reboot`。WS-Man の中継と同じく、Origin(別のサイトのページからの POST を受けない)とログイン(Cookie)を確かめ、talos の先だけを受ける。操作の名前はこの 2 つのほかは 404。
  動かすコマンドはいつも `talosctl --talosconfig <パイプ> --nodes <node> --endpoints <endpoints> shutdown|reboot --wait=false`(`TalosCommand.PowerArguments`)で、ブラウザは引数を足せない。
  `--wait=false` なので、Talos が受け付けたら返る(止まり終わるのは待たない)。talosconfig はダッシュボードと同じく名前付きパイプで渡すので、talosctl は見えない ConPTY で動かし、終了コードが 0 でなければ出力の最後の行を理由として返す。
  同時には 1 つだけ(ほかが動いていれば 409)、60 秒で返らなければ失敗にする。誰がどの先に頼んだかと結果を mado.log に残す
- 開け閉めと終了コードは mado.log に残す。talosconfig の中身と証明書は、画面にもログにも出さない

## 鍵の扱い

### 役割は os:operator

talosconfig は Talos の `os:operator` の役割で作る(`talosctl config new --roles os:operator --crt-ttl 2160h`、90 日)。
ダッシュボードに要るのは読むこと(`os:reader`)だけだが、バーの「シャットダウン」「再起動」には `os:operator` が要る。

- `os:operator` で足されるのは、Talos の文書(RBAC)の言うところで、ノードの再起動・シャットダウン、etcd のバックアップと警報の扱いなど。ノードの設定(machine config)の書き換え、リセット、アップグレードは `os:admin` が要り、mado の PC が乗っ取られてもできない
- **etcd のスナップショットも取れる**。Kubernetes の Secret は Talos の secretbox で暗号化して etcd に入っていて、その鍵はマシンの設定の秘密の部分(`os:operator` では読めない)にあるので、スナップショットからそのままは読めない。ただし ConfigMap などほかのリソースは平文で読める。鍵が漏れたときの影響は `os:reader` より大きい
- それでも `os:operator` にするのは、mado の PC からは AMT で既に強制電源オフ・強制再起動ができ(OS を止めずに切るので、etcd やディスクを壊すおそれがある)、Talos に止める準備をさせてから止める道を足すほうが、普段の操作が安全側になるから。鍵は SYSTEM と Administrators だけが読める場所に DPAPI で置き、90 日で切れる。決めたことは gitops の `docs/decisions.md`
- v0.13 までは `os:reader` だった。その鍵のままでもダッシュボードは使えるが、電源の操作は Talos に断られる(PermissionDenied。画面は setup.ps1 を流し直すよう出す)

### DPAPI(LocalMachine)で保護して置く

talosconfig は Windows の DPAPI で保護した形(`talosconfig.dpapi`)で `C:\ProgramData\mado\` に置く。作るのは gitops の `mado/setup.ps1`。

- 保護の範囲は **LocalMachine**。setup.ps1 は普段のユーザーで秘密を取り出し、サービスは LocalSystem で動くので、CurrentUser の範囲では setup.ps1 が SYSTEM の鍵で保護できない。
  LocalMachine はその PC のどのアカウントでも開けるので、**誰が読めるかはファイルの ACL で絞る**(`C:\ProgramData\mado` は SYSTEM と Administrators だけ)
- DPAPI が守るのは、ファイルだけが外に出たとき(バックアップや、ディスクを別の PC で読まれたとき)。その PC の管理者からは守れない。管理者はどのみち SYSTEM になれるので、CurrentUser(SYSTEM)の範囲にしても変わらない
- 平文の talosconfig は setup.ps1 でもディスクに書かない(SOPS の鍵で作った talosconfig を標準出力で受け取り、メモリの上で保護する)

### talosctl には名前付きパイプで渡す

talosctl は talosconfig を **ファイルの場所でしか受け取らない**(`--talosconfig` か環境変数 `TALOSCONFIG`。中身を標準入力や環境変数で渡す口は無い)。
一時ファイルに書くと、mado が落ちたときや電源が切れたときに平文の鍵がディスクに残る。そこで mado は復号した中身を **名前付きパイプ**(`\\.\pipe\mado-talos-<乱数>`)で渡し、`--talosconfig` にそのパイプの名前を書く。
talosctl(Go)はふつうのファイルと同じように開いて読む(talosctl v1.15 で確かめた)。

- パイプの ACL は mado のアカウント(サービスなら SYSTEM)だけ(`PipeOptions.CurrentUserOnly`)
- つないできた相手のプロセス ID(`GetNamedPipeClientProcessId`)が、mado が動かした talosctl でなければ渡さない(切って同じ口で待ち直す)
- Go は読む前に `os.Stat` でもパイプを 1 度開く。口が 1 つだと 2 度目に「All pipe instances are busy」で落ちるので、口を 4 つ同時に開けておく
- 30 秒たつか口を使い切ったら閉じ、メモリの中身を 0 で消す。ディスクには一度も書かない

一時ファイル(ACL をサービスのアカウントだけにして、終わったら消す)より、ディスクに残らない点と、相手のプロセスを確かめられる点で安全なので、こちらにした。

## 期限が切れたとき・切れそうなとき

証明書は 90 日で切れる(切れると talosctl が `certificate has expired` などで終わり、画面に「talosctl が終了しました(終了コード 1)」と出る)。
14 日を切るとバーに出る。作り直すのは gitops の作業用の PC から:

```powershell
pwsh -File mado/setup.ps1
```

setup.ps1 が管理者の talosconfig(SOPS の Talos の CA からその場で作る)で `os:operator` の talosconfig を作り直し、DPAPI で保護して置き直す。mado の再起動は要らない(開くたびにファイルを読む)。
古い証明書は期限まで有効のまま(Talos のクライアント証明書は取り消せない)。漏れたときは Talos の CA ごと作り直すことになるので、`os:operator`(設定は変えられない)にとどめ、期限を短くしている。

## 試験

- `dotnet run --project tests/Mado.Tests.csproj`(`tests/TalosTests.cs`): 設定の読み込みと間違い、コマンド(ダッシュボードと電源の操作)が固定の形であること、電源の操作の失敗の理由(端末の出力の最後の行)、引数の囲み方、talosctl の探し方、証明書の期限(使う context の crt)、同時の数の上限、
  `/ws/talos` の中継(偽の端末で、トークンと先の種類、入力と大きさの変更、終わり方)。Windows では DPAPI、ConPTY(`cmd.exe` の出力と終了コード)、名前付きパイプ(ほかのプロセスには渡さず、動かしたプロセスには渡す)も
- `bun test web/talos`(`web/talos/dashboard.test.ts`): 最初のメッセージと大きさの変更、閉じた理由の文、期限の知らせ、電源の操作の結果の文
- `tools/amt-e2e/`([amt.md](amt.md#試験)): Linux のコンテナの mado に talos の先を並べ、`e2e.ts` は `/ws/talos` が talos の先のトークンだけを受けること、`ui.cjs` は headless の Chromium で一覧から talos の先を選び(欄が隠れ、ボタンが「開く」)、押すと `/ws/talos` につなぎ、閉じた理由と「もう一度開く」が出て、開き直せることを確かめる。電源の操作は、`e2e.ts` が API の確かめ(Origin・ログイン・先の種類・操作の名前)を、`ui.cjs` がバーの 2 回押し(1 回目で文が変わり赤い字、3 秒で戻る、キーボードで 2 回押すと `POST /api/talos/<名前>/reboot` を 1 度だけ送り、結果がバーに出る)を見る。
  Linux には ConPTY が無いので、mado は talosctl を動かすところで「not supported」で閉じる
- 本物の `talosctl dashboard`(Windows 版 v1.15.0-alpha.2)を ConPTY と名前付きパイプで動かし、画面が描かれること、大きさの変更、`q` で終了コード 0 になることを手元で確かめた(ノードにはつながない設定で)。
  v0.14 では Windows の mado に talos の先を書き、`/api/token` と `/ws/talos` をブラウザの代わりに話して、ダッシュボードの画面(ノードに届かない知らせつき)が流れてくることと、`q` で `exited 0` で閉じることを確かめた。電源の操作も `POST /api/talos/<名前>/reboot` で本物の talosctl が `--wait=false` を受け、届かないノードの理由(最後の行)が返ることを確かめた
