# 自前の RDP クライアント(web/rdp)

IronRDP(WASM)は v0.6.0 で外した。RDP は全部 `web/rdp/` の TypeScript が話し、mado のサーバーは RDCleanPath の中継だけをする。
仕様は Microsoft の公開仕様([MS-RDPBCGR]・[MS-CSSP]・[MS-NLMP]・[MS-RDPRFX]・[MS-RDPEGDI]・[MS-RDPEGFX] など)。迷ったら FreeRDP の実装と突き合わせる。

## 層と担当のファイル

| 層 | 中身 | ファイル |
| --- | --- | --- |
| つなぐ | RDCleanPath(X.224 の接続要求を包んで送り、接続確認と証明書の鎖を受ける)、TPKT / Fast-Path の切り出し | `rdcleanpath.ts` `x224.ts` `stream.ts` |
| ログイン | CredSSP(TSRequest、pubKeyAuth、TSCredentials)と NTLMv2(MIC、署名と封印)。MD4 / MD5 / RC4 / HMAC-MD5 は自前。Kerberos はやらない | `credssp.ts` `ntlm.ts` `crypto.ts` `der.ts` |
| 接続の手順 | MCS / GCC、Client Info、ライセンス、Demand / Confirm Active(能力セット)、同期、Deactivate-Reactivate | `connect.ts` `mcs.ts` `pdu.ts` |
| 画面(旧) | 旧ビットマップ(planar 32bpp・Interleaved RLE)、RemoteFX(Surface Commands)、Frame Acknowledge、同じ位置の古い更新の間引き、Web Worker での復号 | `bitmap.ts` `rfx.ts` `surface.ts` `rfxpool.ts` `rfx.worker.ts` |
| 画面(GFX) | ZGFX、GFX のコマンド、AVC420 / AVC444(WebCodecs)・ClearCodec(NSCodec)・Planar・RemoteFX Progressive。既定でこちら | `gfx.ts` `gfx-canvas.ts` `yuv444.ts` `zgfx.ts` `clearcodec.ts` `progressive.ts` |
| 入力・ポインタ | スキャンコード(JIS / US は OS の配列から判定)、Unicode、マウス、ホイール、ポインタの形 | `input.ts` `pointer.ts` `display.ts` |
| チャネル | 静的チャネルの断片、drdynvc、DisplayControl(窓の大きさへの追従)、cliprdr(文字列だけ) | `vchannel.ts` `dvc.ts` `cliprdr.ts` `channels.ts` |
| まとめ | 受信のループ、画面への振り分け、診断の統計 | `client.ts` |

## Windows の送り方(実機で分かったこと)

- Windows(RemoteFX を使わない)は画面を**旧ビットマップの planar**(ヘッダー 0x13 = YCoCg・色の削減 3・RLE・アルファあり)で送ってくる。
  色差は「8 ビットのままずらしてから符号付きに読む」(FreeRDP の `YCoCgToRGB` と同じ。逆にすると濃い色で赤と青が入れ替わる)
- RemoteFX のタイルは Region の矩形と画面だけで切る(Surface Bits の destRight / destBottom では切らない)
- 間引き(同じ位置の古い更新を復号しない)は、新しい更新の描く範囲が古いものをすっぽり含むときだけ。甘くすると前の絵が残る
- 復号は Web Worker のプールで並列にする(メインスレッドで planar を復号すると全面で約 29ms かかり、スクロールが重かった)
- 試験用 VM のように初期設定(OOBE)のユーザーがコンソールにいると、つなぐたびに取り合いになってログオフされる

## 送り方の選び方(GFX と H.264)

利用者には選ばせない。上から順に試し、使えなければ下へ(`app.ts` の `Mode`):

1. GFX + H.264: ブラウザが H.264 を復号できる(`VideoDecoder.isConfigSupported`)ときだけ、CAPVERSION 8.1 で AVC420 を、10.0〜10.7 で AVC444 / AVC444v2 を宣言する
2. GFX: H.264 の復号が 60 回続けて失敗したら(`onAvcBroken`)、H.264 を宣言せずに(10.x は AVC_DISABLED を付けて)裏でつなぎ直す
3. 旧ビットマップ / RemoteFX: GFX が回復できない形で壊れたら(ZGFX の履歴、`onFatal`)つなぎ直す。接続先が GFX を使えない(チャネルを開かない)ときも、つなぎ直さずにこれになる

つないでいる間の調整(回線・端末の速さ):

- 接続先に任せる分: 回線の自動検出(`autodetect.ts`)に答え、Frame Acknowledge の queueDepth で「受け取ったがまだ描いていないフレームの数」を伝える(端末が遅ければ接続先が送る頻度を下げる)
- こちらで決める分: 画素数(`autoscale.ts`)。StartFrame の時刻(サーバーが作った時刻)から描き終えるまでの遅れのうち「溜まった分」(30 秒のうちいちばん小さい遅れとの差。時計のずれは消える)と未描画のフレーム数を 2 秒ごとに見て、混んでいれば 100→75→50% と下げ、空けば戻す(選んだ割合が上限。つないだ直後・変えた直後は全面の送り直しなので見ない)
- 描画: 画面の canvas は desynchronized(合成を待たない)、GFX の present は描画の周期に 1 回(最初はすぐ)、面の写し・キャッシュ・塗りつぶしは drawImage / fillRect(getImageData は GPU から読み戻すので遅い)。H.264 は GPU で復号できれば prefer-hardware

切り替えた記録は診断に出る。
Windows は H.264 を使わないときも、ClearCodec(NSCodec を含む)と RemoteFX Progressive(写真・スクロールで新しく見えた部分)で送ってくる。
GPU の無い VM では、Windows は 8.1(AVC420)だけを宣言すると版 8 を選び、H.264 を使わなかった。そのため版 10 以上も宣言する(宣言する組み合わせは FreeRDP の `rdpgfx_send_supported_caps` と同じ)。
サーバーが選んだ版は診断の「GFX: 版=」に出る。

AVC444(`yuv444.ts`): 1 つの PDU に主の絵(普通の YUV420)と補助の絵(4:4:4 で足りない色差を YUV420 の形に詰めたもの)が入り、LC で片方だけのこともある。
両方とも同じ VideoDecoder で順に復号し(1 本の H.264 の流れとして扱う。FreeRDP と同じ)、`copyTo` で I420 / NV12 の面を読み出して、面ごとの YUV444 に重ね、CPU で RGBA にして描く。
補助の絵の並べ方は v1(AVC444)と v2(AVC444v2)で違う。並べ方と色差の戻し方は FreeRDP の `prim_YUV.c` に合わせた。AVC420 はこれまでどおり VideoFrame をそのまま drawImage する。
Windows(10.7 を選ぶ)は既定では静かな画面を ClearCodec / Progressive で送り、H.264 は動きの多いところに使う。
「H.264/AVC 444 グラフィックス モードを優先する」を有効にすると全面を AVC444 で送ってくるが、ブラウザでは 2 本の復号と CPU での組み立てで 1 フレーム約 20ms かかり、動きが続くと溜まる(既定のままのほうが軽い)。
GPU を分けた VM(`tools/hyperv-test/add-gpu.ps1`)で「すべてのリモート デスクトップ サービス セッションでハードウェアの既定のグラフィックス アダプターを使用する」を有効にすると、つないでから最初の絵まで約 40 秒かかった(無効なら約 3 秒)。

## 試験

単体の試験は `bun test web`(PDU のバイト列、実データの矩形、偽の通信路での `RdpClient`)。どれもホストに bun や node を入れず、wslc のコンテナで動かす。

### xrdp(MCS から画面・入力・クリップボードまで。CredSSP は無い)

```powershell
wslc run -d --name xrdp -p 13389:3389 danielguerra/ubuntu-xrdp:latest     # 0.9.5。ubuntu / ubuntu。RemoteFX で送る
wslc build -t mado-xrdp-gfx tools/xrdp-gfx                                  # GFX と H.264 が要るとき(xrdp 0.10 を --enable-x264 で)
wslc run -d --name xrdp-gfx -p 13390:3389 mado-xrdp-gfx
wslc run --rm -v "${PWD}:/app" -w /app oven/bun:1 bun build tools/rdp-input-smoke.ts --target node --outfile out/in.mjs
wslc run --rm -v "${PWD}:/app" -w /app -e HOST=<xrdp のコンテナの IP> -e PORT=3389 -e OUT=/app/out/xrdp.png node:lts node out/in.mjs
```

`tools/rdp-input-smoke.ts` は、つないで画面を PNG にし、ボタンのクリック・端末への入力・貼り付けまで試す(bun の TLS は RDP の自己署名証明書を断るので node で動かす)。
xrdp は LICENSE_REQUEST を返すので、試験では `dummyLicense` で答える(Windows は「ライセンス不要」を返す)。

### Windows(Hyper-V)

Windows Sandbox は使えない(3389 の待ち受けを上げるにはリモートデスクトップのサービスの再起動が要り、そのとき Sandbox ごと閉じる)。
wslc のコンテナからは Hyper-V の Default Switch の VM に届かないので、ホストのブラウザから試す。

```powershell
pwsh -File tools/hyperv-test/new-test-vm.ps1 -Iso <Windows 11 の ISO>   # UAC で昇格。~/.mado-test/ に IP とパスワード
wslc run --rm -v "${PWD}:/app" -w /app oven/bun:1 bun run build:web
pwsh -File tools/hyperv-test/mini-mado.ps1 -Target <VM の IP>          # http://localhost:8790/(本物の Relay.cs をコンパイルして使う)
pwsh -File tools/hyperv-test/vm-exec.ps1 -Command 'quser'              # VM の中でコマンド(PowerShell Direct)
```
