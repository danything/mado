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
| 画面(GFX) | ZGFX、GFX のコマンド、AVC420(WebCodecs)・ClearCodec・Planar。フォームの「H.264(試験中)」のときだけ | `gfx.ts` `gfx-canvas.ts` `zgfx.ts` `clearcodec.ts` |
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

## H.264(GFX)

既定は旧ビットマップ / RemoteFX。フォームの「H.264(試験中)」をオンにし、ブラウザが H.264 を復号できるときだけ GFX(CAPVERSION 8.1 の AVC420)を宣言する。
未対応: AVC444、Progressive、ClearCodec の NSCodec。Windows での確認はまだ。
接続先の Windows でグループ ポリシーの「H.264/AVC 444 グラフィックス モードを優先する」「H.264/AVC ハードウェア エンコードを構成する」を有効にすると、H.264 で送らせやすい。

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
