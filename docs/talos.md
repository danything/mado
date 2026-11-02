# Talos のダッシュボード

AMT の先で Talos が動いているなら、AMT の画面のバーから `talosctl dashboard` を開ける。
mado が mado の PC の上で talosctl を擬似端末(Windows の ConPTY)で動かし、その画面とキー入力を WebSocket で中継する。
画面は SOL と同じ端末(xterm.js)に出す。SOL ではカーネルの文字しか見えないが、ダッシュボードなら CPU・メモリ・サービス・ログが見られる。

```
ブラウザ ──wss /ws/talos(画面とキー入力)──> mado ──ConPTY──> talosctl.exe dashboard ──Talos API(50000、os:reader)──> ノード
                                              └─名前付きパイプ(talosconfig)─┘
```

## 設定

AMT の先に `talos` を足す。無い先ではボタンを出さない。

```json
{
  "name": "Z440(AMT)",
  "type": "amt",
  "host": "10.10.0.3",
  "talos": {
    "talosconfig": "talosconfig.dpapi",
    "node": "10.10.0.4",
    "endpoints": ["10.10.0.4"],
    "talosctl": "bin/talosctl.exe"
  }
}
```

| 項目          | 内容                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `talosconfig` | DPAPI で保護した talosconfig(下の「鍵の扱い」)。相対なら mado.json の場所から。役割は `os:reader` だけにする               |
| `node`        | ダッシュボードで見るノード(`--nodes`)。アドレスかホスト名                                                                  |
| `endpoints`   | Talos API の入口(`--endpoints`)。既定は `[node]`                                                                           |
| `talosctl`    | `talosctl.exe` の場所。相対なら mado.json の場所から。書かなければサービスの `PATH` から探す。無ければ開くときに失敗を返す |

`talos` は `type` が `amt` の先にだけ書ける。値の形が違えば起動のときに止まる(`-` で始まる値は talosctl のフラグと読まれるので受け付けない)。
古い mado(v0.12 まで)は知らない項目を読み飛ばすので、mado.json を先に置いても落ちない。

## 使い方

1. AMT の先を開く(AMT のユーザー名とパスワードが要るのは今までどおり)
2. バーの「ダッシュボード」を押す。SOL をつないでいれば切り、同じ端末に `talosctl dashboard` が出る
   - 端末の大きさは窓に合わせ、変えると talosctl にも伝える(ConPTY の大きさを変える)
   - キーはそのまま talosctl に届く。F1〜F4 で画面を切り替え、`q` か Ctrl+C で終わる
3. 「ダッシュボードを閉じる」か `q` で終わる。SOL をつないでいたなら、つなぎ直す
4. talosconfig の証明書の期限が 14 日を切ると、AMT の画面を開いたときにバーに「Talos の証明書はあと N 日で切れます」と出る(切れたら「期限が切れています」)

## しくみ

- `/ws/talos` の WebSocket。`/ws/amt` と同じく、Origin とログイン(Cookie)を確かめ、最初のテキストのメッセージ `{"token": "…", "cols": 120, "rows": 40}` の `token` が `/api/token` の使い捨てのトークン(60 秒、1 度だけ、同じログインのもの)のときだけ続ける。
  トークンの中の先が AMT で、`talos` の設定があるときだけ動かす(RDP の先や `talos` の無い AMT の先のトークンでは動かさない)
- 動かすコマンドはいつも `talosctl --talosconfig <パイプ> --nodes <node> --endpoints <endpoints> dashboard` で、値は全部 mado.json から来る(`server/Talos.cs` の `TalosCommand`)。
  ブラウザが送れるのは端末の大きさとキー入力だけで、コマンドや引数は選べない
- あとはバイナリのメッセージが端末の入出力、テキストの `{"cols": …, "rows": …}` が大きさの変更。talosctl が終わると mado は `exited <終了コード>` の理由で閉じる。ブラウザが閉じれば talosctl を止める
- 擬似端末は ConPTY(`CreatePseudoConsole`)を P/Invoke(`LibraryImport`。Native AOT で動く)で直接呼ぶ(`server/ConPty.cs`)。
  talosctl は「閉じたら中を全部止める」ジョブに入れてから動かすので、mado が落ちても talosctl は残らない
- 同時に動かすのは 4 つまで。開いている間は接続として数え、その間は自動更新しない
- 開け閉めと終了コードは mado.log に残す。talosconfig の中身と証明書は、画面にもログにも出さない

## 鍵の扱い

### 役割は os:reader だけ

ダッシュボードに要るのは読むことだけなので、talosconfig は Talos の `os:reader` の役割で作る(`talosctl config new --roles os:reader --crt-ttl 2160h`、90 日)。
mado の PC が乗っ取られても、ノードの設定は変えられない(`os:reader` はログ・状態・設定の秘密でない部分を読める)。

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

setup.ps1 が管理者の talosconfig(SOPS の Talos の CA からその場で作る)で `os:reader` の talosconfig を作り直し、DPAPI で保護して置き直す。mado の再起動は要らない(開くたびにファイルを読む)。
古い証明書は期限まで有効のまま(Talos のクライアント証明書は取り消せない)。漏れたときは Talos の CA ごと作り直すことになるので、`os:reader` に絞り、期限を短くしている。

## 試験

- `dotnet run --project tests/Mado.Tests.csproj`(`tests/TalosTests.cs`): 設定の読み込みと間違い、コマンドが固定の形であること、引数の囲み方、talosctl の探し方、証明書の期限(使う context の crt)、同時の数の上限、
  `/ws/talos` の中継(偽の端末で、トークンと先の種類、入力と大きさの変更、終わり方)。Windows では DPAPI、ConPTY(`cmd.exe` の出力と終了コード)、名前付きパイプ(ほかのプロセスには渡さず、動かしたプロセスには渡す)も
- `bun test web/amt`(`web/amt/dashboard.test.ts`): 最初のメッセージと大きさの変更、閉じた理由の文、期限の知らせ
- 本物の `talosctl dashboard`(Windows 版 v1.15.0-alpha.2)を ConPTY と名前付きパイプで動かし、画面が描かれること、大きさの変更、`q` で終了コード 0 になることを手元で確かめた(ノードにはつながない設定で)
