# RDP クライアント(web/rdp)

RDP は `web/rdp/` の TypeScript がすべて話す。mado のサーバーは RDCleanPath で中継するだけ。IronRDP(WASM)は v0.6.0 で外した。
仕様は Microsoft の公開仕様([MS-RDPBCGR]、[MS-CSSP]、[MS-NLMP]、[MS-RDPRFX]、[MS-RDPEGDI]、[MS-RDPEGFX] など)に従う。分かりにくいところは FreeRDP の実装と照らし合わせる。

## 層とファイル

| 層 | 内容 | ファイル |
| --- | --- | --- |
| 接続 | RDCleanPath(X.224 の接続要求を送り、接続確認と証明書チェーンを受け取る)、TPKT / Fast-Path の切り出し | `rdcleanpath.ts` `x224.ts` `stream.ts` |
| 認証 | CredSSP と NTLMv2。MD4 / MD5 / RC4 / HMAC-MD5 は自前。Kerberos は未対応 | `credssp.ts` `ntlm.ts` `crypto.ts` `der.ts` |
| 接続シーケンス | MCS / GCC、Client Info、ライセンス、Demand / Confirm Active、同期、Deactivate-Reactivate、回線の自動検出 | `connect.ts` `mcs.ts` `pdu.ts` `autodetect.ts` |
| 画面(旧来) | 旧ビットマップ(planar 32bpp、Interleaved RLE)、RemoteFX(Surface Commands)、Frame Acknowledge、古い更新の間引き、Web Worker での復号 | `bitmap.ts` `rfx.ts` `surface.ts` `rfxpool.ts` `rfx.worker.ts` |
| 画面(GFX) | ZGFX、GFX のコマンド、AVC420 / AVC444(WebCodecs)、ClearCodec(NSCodec)、Planar、RemoteFX Progressive、解像度の自動調整 | `gfx.ts` `gfx-canvas.ts` `yuv444.ts` `zgfx.ts` `clearcodec.ts` `progressive.ts` `autoscale.ts` |
| 入力とポインタ | スキャンコード(JIS / US は OS の配列から判定)、Unicode、マウス、ホイール、ポインタの形 | `input.ts` `pointer.ts` `display.ts` |
| チャネル | 静的チャネルの分割、drdynvc、DisplayControl(窓の大きさへの追従)、cliprdr(テキストのみ) | `vchannel.ts` `dvc.ts` `cliprdr.ts` `channels.ts` |
| 全体 | 受信ループ、画面への振り分け、診断用の統計 | `client.ts` |

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
- 版 10.7 を選んだ Windows は、既定の設定では静止した画面を ClearCodec / Progressive で送り、H.264 は動きの多い部分に使う
- グループ ポリシー「H.264/AVC 444 グラフィックス モードを優先する」を有効にすると、全面を AVC444 で送ってくる。ブラウザ側は 2 本の復号と CPU での合成で 1 フレーム約 20ms かかり、動きが続くと遅延が溜まる。既定の設定のほうが軽い
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
wslc run --rm -v "${PWD}:/app" -w /app -e HOST=<xrdp のコンテナの IP> -e PORT=3389 -e OUT=/app/out/xrdp.png node:lts node out/in.mjs
```

`tools/rdp-input-smoke.ts` は接続して画面を PNG に保存し、ボタンのクリック、端末への入力、貼り付けを試す。bun の TLS は RDP の自己署名証明書を受け付けないので node で動かす。
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
