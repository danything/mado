# RDP クライアント(web/rdp)

RDP は `web/rdp/` の TypeScript がすべて話す。mado のサーバーは RDCleanPath で中継するだけ。IronRDP(WASM)は v0.6.0 で外した。
仕様は Microsoft の公開仕様([MS-RDPBCGR]、[MS-CSSP]、[MS-NLMP]、[MS-RDPRFX]、[MS-RDPEGDI]、[MS-RDPEGFX] など)に従う。分かりにくいところは FreeRDP の実装と照らし合わせる。

## 層とファイル

| 層             | 内容                                                                                                                                | ファイル                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 接続           | RDCleanPath(X.224 の接続要求を送り、接続確認と証明書チェーンを受け取る)、WebTransport / WebSocket の道、TPKT / Fast-Path の切り出し | `rdcleanpath.ts` `x224.ts` `stream.ts`                                                         |
| 認証           | CredSSP と NTLMv2。MD4 / MD5 / RC4 / HMAC-MD5 は自前。Kerberos は未対応                                                             | `credssp.ts` `ntlm.ts` `crypto.ts` `der.ts`                                                    |
| 接続シーケンス | MCS / GCC、Client Info、ライセンス、Demand / Confirm Active、同期、Deactivate-Reactivate、回線の自動検出                            | `connect.ts` `mcs.ts` `pdu.ts` `autodetect.ts`                                                 |
| 画面(旧来)     | 旧ビットマップ(planar 32bpp、Interleaved RLE)、RemoteFX(Surface Commands)、Frame Acknowledge、古い更新の間引き、Web Worker での復号 | `bitmap.ts` `rfx.ts` `surface.ts` `rfxpool.ts` `rfx.worker.ts`                                 |
| 画面(GFX)      | ZGFX、GFX のコマンド、AVC420 / AVC444(WebCodecs)、ClearCodec(NSCodec)、Planar、RemoteFX Progressive、解像度の自動調整               | `gfx.ts` `gfx-canvas.ts` `yuv444.ts` `zgfx.ts` `clearcodec.ts` `progressive.ts` `autoscale.ts` |
| 入力とポインタ | スキャンコード(JIS / US は OS の配列から判定)、Unicode、マウス、ホイール、ポインタの形                                              | `input.ts` `pointer.ts` `display.ts`                                                           |
| チャネル       | 静的チャネルの分割、drdynvc、DisplayControl(窓の大きさへの追従)、cliprdr(テキストのみ)                                              | `vchannel.ts` `dvc.ts` `cliprdr.ts` `channels.ts`                                              |
| バルク圧縮     | MPPC(RDP 4.0 / 5.0)の伸長。Fast-Path、Share Data、静的チャネル                                                                      | `mppc.ts`                                                                                      |
| 全体           | 受信ループ、画面への振り分け、診断用の統計                                                                                          | `client.ts`                                                                                    |

## バルク圧縮

Client Info で INFO_COMPRESSION を立て、RDP 5.0(履歴 64KB)まで受けると伝える(`ConnectOptions.compression`、既定は on)。サーバーは RDP 4.0(8KB)を選ぶこともあるので、伸長はどちらも扱う。RDP 6.0 / 6.1 は宣言しない。
GFX のデータは ZGFX で別に圧縮されているので、効くのは旧ビットマップ、ポインタ、チャネルのデータ。

- 履歴は I/O チャネル(Fast-Path と Share Data)で 1 つ。サーバーは送った順に圧縮するので、届いた順に伸長する。つなぐ途中に届いた Fast-Path も、溜める前にその場で伸長する(`readIo`)
- Fast-Path と静的チャネルは、断片ごとに伸長してから組み立てる
- 静的チャネルは I/O チャネルとは別の履歴を 1 つ持つ。仕様に書かれておらず、xrdp はチャネルを圧縮しないので、実機では確かめていない
- 圧縮していないパケットは履歴に入れない。FLUSHED で履歴を 0 で埋め、AT_FRONT で書く位置を先頭に戻す(FreeRDP の `mppc.c` と同じ)
- 1 つのパケットは履歴より大きくならない。履歴の外を指す一致や、途中で切れた符号は例外にする
- 診断の「圧縮:」に、伸長したパケットの数と前後のバイト数が出る。xrdp(旧来の描画)では約 1.7MB を 2.8MB に伸長した

## 中継の道(WebTransport と WebSocket)

RDCleanPath と、その後の RDP のバイトは、mado との 1 本の道に流す(`stream.ts`、`connect.ts` の `openTransport`)。

- `/api/session` に `wt` があり、ブラウザに `WebTransport` があれば、先に WebTransport(HTTP/3、UDP)で `/wt` を開く。`ready` を 1.5 秒待ち、双方向の stream を 1 本開いてそこに流す
- 開けなければ、黙って WebSocket(`/ws`)にする。サーバーが CONNECT を受けた後で待ち時間が切れることもあるので、トークンは取り直す
- どちらも、届いたかたまりを溜めて要る分だけ切り出す(`ChunkStream`)。RDCleanPath の形も同じ
- 診断の 1 行目に、使っている道(WebTransport / WebSocket)が出る

サーバーは msquic を直接呼んで HTTP/3 と WebTransport を話す(`server/Quic/`)。Chrome は WebTransport の draft-02 を宣言してくるので、サーバーは draft-02 と draft-07 の両方を宣言する。輻輳制御は BBR。
WebTransport の CONNECT には Cookie が付かないので、Origin と使い捨てのトークンで確かめる(`server/WebTransportRelay.cs`)。
トークンは `/wt?token=` に付け、サーバーは CONNECT で使う(2 度目の CONNECT は 401)。RDCleanPath の proxy_auth には同じトークンを入れる。
WebSocket に移るときは、`newToken` でトークンを取り直す。mado はパスをログに書かないので、トークンはログに残らない。

## RDP サーバーの証明書

mado は RDP サーバーとの TLS で証明書を検証しない(`server/Relay.cs`)。RDP の証明書はふつう自己署名で、検証できる相手がいないため。
そのかわり、RDCleanPath の応答に入っている証明書チェーンの先頭(leaf)を、ブラウザがつなぐ先ごとに覚えて比べる(trust on first use。mstsc の「この証明書を信頼するか」と同じ考え方)。

CredSSP は証明書の公開鍵に結びつけて認証するが、どの証明書かは見ない。mado と RDP サーバーの間に割り込んだ相手は自分の証明書を出せるので、
確かめずに進むと、その相手と CredSSP(NTLM)のやりとりをしてしまう。そのため、確かめるのは RDCleanPath の応答のあと、CredSSP の前にする(`connect.ts` の `checkCert`)。断ったときはユーザー名もパスワードも使わずに閉じる。

- 指紋は leaf の DER 全体の SHA-256。大文字の 16 進を `:` でつなぐ(`web/certpin.ts`)
- 覚えていない先: 名前(subject の CN)、有効期間、指紋を見せて、「信頼してつなぐ」か「やめる」かを聞く。信頼したら覚える
- 覚えた指紋と同じ: 何も聞かずにつなぐ
- 覚えた指紋と違う: 前と今の指紋を並べて警告する。最初は「やめる」にフォーカスがあり、Enter や Esc ではつながない。「置き換えてつなぐ」を選んだときだけ、新しい指紋で覚え直す
- 覚える場所はブラウザの localStorage(`mado:certs`、つなぐ先の名前 → 指紋)。ブラウザやプロファイルごとに別で、サイトのデータを消したときや、保存できないブラウザ(設定で止めているなど)では毎回聞く。mado のサーバーには送らない
- 聞いている間は、つなぐまでの時間切れ(30 秒)を止める。長く置くと RDP サーバーのほうが切ることがあり、そのときはもう一度つなぐ(信頼した指紋は覚えている)

Windows の RDP の証明書の指紋は、接続先の PowerShell で調べられる。表示は `:` の無い形なので、並びで比べる。

```powershell
(Get-ChildItem 'Cert:\LocalMachine\Remote Desktop').ForEach({ $_.GetCertHashString('SHA256') })
```

証明書を作り直したとき(PC の名前を変えた、期限が来て作り直された、グループ ポリシーで別の証明書にしたなど)は、指紋が変わったという警告が出る。作り直したと分かっていれば「置き換えてつなぐ」でよい。

`tools/rdp-input-smoke.ts` は画面を持たないので聞けない。`CERT_SHA256` で指紋を指定するか、試験のときだけ `INSECURE_TLS=1` で確かめずに進む。

## 転送方式の選択

ユーザーには選ばせず、上から順に試す(`app.ts` の `Mode`)。

1. GFX + H.264。ブラウザが H.264 を復号できるとき(`VideoDecoder.isConfigSupported`)だけ、版 8.1 で AVC420、版 10.0〜10.7 で AVC444 / AVC444v2 を宣言する
2. GFX。H.264 の復号が 60 回続けて失敗したら(`onAvcBroken`)、H.264 を宣言せずにつなぎ直す。版 10.x には AVC_DISABLED を付ける
3. 旧ビットマップ / RemoteFX。GFX が回復できない状態になったら(ZGFX の履歴が壊れたとき、`onFatal`)つなぎ直す。接続先が GFX のチャネルを開かなければ、つなぎ直さずにこの方式になる

切り替えの記録は診断に出る。

## 回線と端末への追従

- 回線の自動検出(`autodetect.ts`)に応答し、Frame Acknowledge の queueDepth で未描画のフレーム数を伝える。接続先はこれを見て画質や送る頻度を変える
- 解像度はクライアントで決める(`autoscale.ts`)。GFX の StartFrame に付くサーバーの時刻と、描画を終えた時刻の差を測る。直近 30 秒の最小値からの増分を遅延の増加とみなすので、時計のずれは影響しない。この増分と未描画のフレーム数を 2 秒ごとに見て、混んでいれば 100% → 75% → 50% と下げ、空けば戻す。接続直後と解像度を変えた直後は全面の再送が来るので判定しない
- 画面の canvas は `desynchronized` にして、ブラウザの合成を待たずに表示する。GFX の present は描画の周期に 1 回にまとめる(周期の最初のフレームはすぐ出す)
- 面のコピー、キャッシュ、塗りつぶしは drawImage と fillRect で行う。getImageData は GPU から読み戻すので遅い
- H.264 は GPU で復号できれば `prefer-hardware` を指定する。GPU での復号が失敗したら CPU の復号で作り直す
- Progressive のタイルは Web Worker で並列に復号する。タイルは前の段の係数を覚えているので、同じ位置のタイルはいつも同じ Worker に送る(`rfxpool.ts` の `runOn`)。データが届いた時点で Worker に渡し、描くのは届いた順にする。そのため前のフレームを描いている間に次のフレームの復号が進む。メインスレッドで復号していたときは、スクロール中に 1 PDU あたり約 10ms かかっていた

## Windows の挙動(実機で確認したこと)

- RemoteFX を使わない Windows は、画面を旧ビットマップの planar(ヘッダー 0x13: YCoCg、色の削減 3、RLE、アルファあり)で送る。
  色差は 8 ビットのままシフトしてから符号付きで読む(FreeRDP の `YCoCgToRGB` と同じ)。順序を逆にすると、濃い色で赤と青が入れ替わる
- RemoteFX のタイルは Region の矩形と画面の範囲で切る。Surface Bits の destRight / destBottom では切らない
- 古い更新を間引くのは、新しい更新が古い更新の範囲を完全に覆うときだけ。条件を緩めると前の絵が残る
- 復号は Web Worker のプールで並列に行う。メインスレッドで planar を復号すると全面で約 29ms かかり、スクロールが重かった
- 試験用 VM で初期設定(OOBE)のユーザーがコンソールにいると、接続のたびにセッションを取り合ってログオフされる
- H.264 を使わないときも、Windows は ClearCodec(NSCodec を含む)と RemoteFX Progressive(写真やスクロールで新しく見えた部分)で送る
- 版 8.1(AVC420)だけを宣言すると、Windows は版 8 を選んで H.264 を使わなかった。そのため版 10 以上も宣言する。宣言する組み合わせは FreeRDP の `rdpgfx_send_supported_caps` と同じ。選ばれた版は診断の「GFX: 版=」で分かる
- Progressive は、同じフレームの前の PDU で送ったタイルを、後の PDU の矩形にも描かせる(矩形だけでタイルの無い PDU も来る。符号化の文脈 codecContextId を並行して使う)。そのため、PDU ごとに「このフレームで復号したタイル全部」をその PDU の矩形で切って描く(FreeRDP の `update_tiles` と同じ)。その PDU のタイルだけを描くと、窓を動かしたあとの空いたところが描かれずに残像になった
- 接続の種類(Client Core の connectionType)を AUTODETECT にすると、Windows は Client Info の performanceFlags を無視して見た目を自分で決め、壁紙も出した。そのため connectionType は LAN にし、回線の測定は SUPPORT_NETCHAR_AUTODETECT だけで続ける。performanceFlags では、壁紙、ドラッグ中の中身、メニューのアニメーション、テーマ、カーソルの影を切る
- 版 10.7 を選んだ Windows は、既定の設定では静止した画面を ClearCodec / Progressive で送り、H.264 は動きの多い部分に使う
- グループ ポリシー「H.264/AVC 444 グラフィックス モードを優先する」を有効にすると、全面を AVC444 で送ってくる。ブラウザ側は 2 本の復号と面の読み出しで 1 フレーム約 15ms かかる(合成は GPU で約 1ms)。動きが続くと遅延が溜まるので、既定の設定のほうが軽い
- GPU を割り当てた VM(`tools/hyperv-test/add-gpu.ps1`)で「すべてのリモート デスクトップ サービス セッションでハードウェアの既定のグラフィックス アダプターを使用する」を有効にすると、接続から最初の画面まで約 40 秒かかった。無効なら約 3 秒

## AVC444

1 つの PDU に主の画像(普通の YUV420)と補助の画像(4:4:4 に足りない色差を YUV420 の形に詰めたもの)が入る。LC の値によってはどちらか片方だけのこともある。
2 つとも同じ VideoDecoder で順に復号する(1 本の H.264 ストリームとして扱う。FreeRDP と同じ)。`copyTo` で I420 / NV12 の面を読み出し、面ごとの YUV444 に重ねて RGB に変換する。重ね合わせと変換は WebGL2 のシェーダーで行い、WebGL2 が使えないときや GPU を失ったときは CPU で行う(`yuv444.ts`)。実機では 1 フレームの組み立てが CPU の約 5ms から約 1ms になった。`copyTo` で面を読み出す分(復号の待ちと合わせて約 15ms)は残る。
補助の画像の並び方は v1(AVC444)と v2(AVC444v2)で違う。並び方と色差の復元は FreeRDP の `prim_YUV.c` に合わせた。AVC420 は VideoFrame をそのまま drawImage する。

## テスト

単体テストは `bun test web`。PDU のバイト列、実データの矩形、偽の通信路での `RdpClient` などを確かめる。ホストに bun や node は入れず、wslc のコンテナで動かす。

### xrdp(MCS から画面、入力、クリップボードまで。CredSSP は無い)

```powershell
wslc run -d --name xrdp -p 13389:3389 danielguerra/ubuntu-xrdp:latest     # 0.9.5。ubuntu / ubuntu。RemoteFX で送る
wslc build -t mado-xrdp-gfx tools/xrdp-gfx                                  # GFX と H.264 を試すとき(xrdp 0.10 を --enable-x264 で)
wslc run -d --name xrdp-gfx -p 13390:3389 mado-xrdp-gfx
wslc run --rm -v "${PWD}:/app" -w /app oven/bun:1 bun build tools/rdp-input-smoke.ts --target node --outfile out/in.mjs
wslc run --rm -v "${PWD}:/app" -w /app -e HOST=<xrdp のコンテナの IP> -e PORT=3389 -e OUT=/app/out/xrdp.png -e INSECURE_TLS=1 node:lts node out/in.mjs
```

`tools/rdp-input-smoke.ts` は接続して画面を PNG に保存し、ボタンのクリック、端末への入力、貼り付けを試す。bun の TLS は RDP の自己署名証明書を受け付けないので node で動かす。
RDP の証明書は自己署名なので、手元のコンテナの xrdp を相手にするときは `INSECURE_TLS=1` で検証を外す(明示しないと CA で確かめて失敗する)。そのとき表示される指紋を `CERT_SHA256` に渡すと、その証明書かどうかだけを確かめる。手元のコンテナ以外につなぐときは `CERT_SHA256` を使う。
xrdp は LICENSE_REQUEST を返すので、試験では `dummyLicense` で応答する。Windows は「ライセンス不要」を返す。

### Windows(Hyper-V)

Windows Sandbox は使えない。3389 で待ち受けるにはリモート デスクトップのサービスの再起動が必要で、そのとき Sandbox ごと閉じてしまう。
wslc のコンテナからは Hyper-V の Default Switch 上の VM に届かないので、ホストのブラウザから試す。

```powershell
pwsh -File tools/hyperv-test/new-test-vm.ps1 -Iso <Windows 11 の ISO>   # UAC で昇格。IP とパスワードは ~/.mado-test/ に
wslc run --rm -v "${PWD}:/app" -w /app oven/bun:1 bun run build:web
pwsh -File tools/hyperv-test/mini-mado.ps1 -Target <VM の IP>          # http://localhost:8790/(本物の Relay.cs をコンパイルして使う)
pwsh -File tools/hyperv-test/vm-exec.ps1 -Command 'quser'              # VM の中でコマンドを実行(PowerShell Direct)
pwsh -File tools/hyperv-test/add-gpu.ps1                               # ホストの GPU を VM に割り当てる(GPU-P)
```
