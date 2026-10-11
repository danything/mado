# 自前の RDP クライアント(H.264)— やることのメモ

> **進み具合**: 層 1〜5(つなぐ・CredSSP・接続手順・Fast-Path の入出力・動的チャネル)と層 7(DisplayControl・クリップボード)は実装済みで、IronRDP は外した。
> 画面は 16 ビット色の Interleaved RLE(ビットマップ)で受けている。層 6(GFX / H.264)は未着手。
> Windows に対して(CredSSP を含む)の実機確認は、正しいパスワードでまだしていない。

ブラウザの IronRDP(WASM)を、mado が使っている機能だけの小さい TS 実装に置き換え、画面を H.264(WebCodecs)で映す。
サーバー側(mado の RDCleanPath の中継)は今のまま使う。

## 方針(2026-10-11)

- **ログイン(CredSSP / NTLM)は自前で書かない。** Devolutions の sspi-rs(または IronRDP の接続確立の部分)を
  小さい WASM にして呼ぶ。暗号の部分はよく使われている実装に任せる
- **それより後を TS で書く**(層 3〜7)。遅さの元の画面(GFX、AVC420 → WebCodecs)は全部こちらに入るので、目的は果たせる
- 境目は「CredSSP が終わったあとの WsStream」。WASM 側はそこまでをやり、以降の PDU は TS が読み書きする
- それでも難しければ、IronRDP を使い続け、上流の GFX / H.264 対応を待って依存を上げる(案 B)
- ビルドと試験は wslc のコンテナで(bun / rust / dotnet をホストに入れない)。PDU の解釈は bun test で単体の試験を書く

## いまあるもの(ブランチ feat/own-rdp、未コミット・未試験)

| ファイル | 中身 |
| --- | --- |
| `web/rdp/bytes.ts` | バイト列の読み書き(LE / BE)|
| `web/rdp/der.ts` | DER / BER、証明書から公開鍵を取り出す |
| `web/rdp/stream.ts` | `/ws` の WebSocket を RDP の流れとして読み書きする `WsStream` |
| `web/rdp/rdcleanpath.ts` | RDCleanPath の要求と応答 |
| `web/rdp/crypto.ts`・`ntlm.ts`・`credssp.ts` | 書きかけ。上の方針で WASM に置き換えるので消す |

## 試す相手

- Windows Sandbox はこの PC に入っていない
- wslc のコンテナからこの PC の 3389 には `172.25.32.1` で届く。ただし別のユーザーで入ると、コンソールのセッションが切れる
- 試験用の VM かアカウントを決める

## いま IronRDP に任せていること(web/app.ts)

置き換えるなら、少なくともこれは同じだけ動くこと。

- RDCleanPath で mado の /ws につなぐ(TLS は mado が RDP サーバーと張る)
- CredSSP(NLA)でログイン。パスワードはブラウザの中だけ
- 画面の表示(今は IronRDP が RemoteFX / ビットマップで受けている)
- キーボード・マウス
- 解像度の自動追従(`displayControl`、MS-RDPEDISP)
- クリップボード(`setEnableClipboard(true)`、MS-RDPECLIP)

## 層ごとにやること

仕様はどれも Microsoft の公開仕様([MS-RDPBCGR] など)。各層は FreeRDP / IronRDP の実装を読み比べながら書く。

### 1. つなぐ(RDCleanPath)

- [ ] X.224 Connection Request(PROTOCOL_HYBRID を要求)を RDCleanPath の要求に入れて送る
- [ ] 応答から X.224 Connection Confirm と RDP サーバーの証明書の鎖を取り出す(server/RdCleanPath.cs と同じ DER)
- [ ] 以降は WebSocket のバイナリをそのまま RDP の流れとして読み書きする(TPKT / Fast-Path の切り出し)

### 2. ログイン(CredSSP、[MS-CSSP] / [MS-NLMP])

- [ ] TSRequest の DER(読み書き)
- [ ] NTLMv2(NEGOTIATE / CHALLENGE / AUTHENTICATE、MIC、署名と封印)
- [ ] pubKeyAuth(サーバー証明書の公開鍵を使う。CredSSP v5 以降はハッシュの形)
- [ ] TSCredentials(ユーザー名・パスワード)を封印して送る
- [ ] 暗号: WebCrypto に MD4 / MD5 / RC4 が無いので自前で書く(HMAC-MD5 も)
- Kerberos はやらない(ローカル アカウント / NTLM だけ)

### 3. 接続の手順([MS-RDPBCGR] 1.3.1.1)

- [ ] MCS Connect Initial + GCC Conference Create(Client Core / Security / Network / Cluster Data。チャネルは drdynvc と cliprdr)
- [ ] Erect Domain / Attach User / Channel Join(使うチャネルの数だけ)
- [ ] Client Info PDU(自動ログオンのフラグ)
- [ ] ライセンス(多くは「ライセンス不要」の応答を受けるだけ)
- [ ] Demand Active を受けて Confirm Active を返す(能力セット: General / Bitmap / Order / Input / Pointer / VirtualChannel / MultifragmentUpdate / LargePointer / SurfaceCommands など)
- [ ] Synchronize / Control (Cooperate, Request Control) / Font List
- [ ] Deactivate-Reactivate(解像度変更のとき)に対応

### 4. 入力と出力(Fast-Path)

- [ ] 入力: スキャンコード(KeyboardEvent.code → スキャンコードの表)、Unicode、マウス(移動・ボタン・ホイール)
- [ ] 出力: Fast-Path Update の切り出し、断片の組み立て
- [ ] マウス ポインタ(新しいポインタ / キャッシュ / 位置 / 非表示)→ CSS の cursor に描く

### 5. 動的チャネル([MS-RDPEDYC])

- [ ] drdynvc の Capabilities / Create / Data First / Data / Close
- [ ] 上に載せるもの: `Microsoft::Windows::RDS::Graphics`(GFX)、`Microsoft::Windows::RDS::DisplayControl`(解像度)

### 6. 画面(GFX、[MS-RDPEGFX])— ここが本題

- [ ] CapsAdvertise(AVC420 を使える版。AVC444 は後回し)/ CapsConfirm
- [ ] ResetGraphics / CreateSurface / DeleteSurface / MapSurfaceToOutput
- [ ] StartFrame / EndFrame と FrameAcknowledge(返さないとサーバーが送るのを止める。遅延の調整もここ)
- [ ] WireToSurface1:
  - [ ] AVC420: メタブロック(更新された矩形と品質)と H.264 の Annex B を分けて、WebCodecs の `VideoDecoder`(`optimizeForLatency: true`)に渡す。デコードした絵から、更新された矩形だけを面に写す
  - [ ] AVC444 は後(輝度と色差の 2 本を組み合わせる)
  - [ ] 文字などで AVC 以外のコーデックが来ても描けるようにする(Planar / Uncompressed。ClearCodec が必要になるかは確かめる)
- [ ] SolidFill / SurfaceToSurface / SurfaceToCache / CacheToSurface / EvictCacheEntry / CacheImportReply
- [ ] 面(OffscreenCanvas)→ 出力の canvas へ描く

### 7. 解像度とクリップボード

- [ ] DisplayControl: Monitor Layout PDU(今の「自動」と同じ動き)
- [ ] cliprdr([MS-RDPECLIP]): 文字列(CF_UNICODETEXT)だけ。ブラウザの Clipboard API との行き来

## サーバー(Windows)側の設定

H.264 で送らせるには、接続先の Windows で次を有効にしておく(グループ ポリシー、またはレジストリ)。

- 「リモート デスクトップ接続用の H.264/AVC 444 グラフィックス モードを優先する」
- 「リモート デスクトップ接続用の H.264/AVC ハードウェア エンコードを構成する」(GPU があるとき)

setup.ps1 で入れるかは、効くことを確かめてから決める。

## 試験

- 相手: Windows Sandbox に RDP を通したもの(C:\sandbox\rdp.wsb)と、このPC(127.0.0.1)
- 層ごとに、実際にやりとりした PDU を取っておき、それを入れる単体の試験を書く(CredSSP / MCS / GFX の解釈)
- 比べる相手: 同じ接続先に IronRDP(今の mado)と mstsc でつないだときの動き

## 順番

1. 層 1〜4 で、ログインして「ビットマップ」で映るところまで(GFX なし)
2. 層 5〜6 で、AVC420 に切り替える
3. 層 7(解像度・クリップボード)をそろえたら、IronRDP の依存を消す
4. AVC444、フレーム応答の調整

## 実機試験の手順(xrdp)

Windows の資格情報が無くても、別実装の RDP サーバー(xrdp)で、MCS から画面の受信まで確かめられる(CredSSP は xrdp に無いので対象外)。

```powershell
wslc run -d --name xrdp -p 13389:3389 danielguerra/ubuntu-xrdp:latest   # ユーザー ubuntu / パスワード ubuntu
bun build tools/rdp-smoke.ts --target node --outfile out/rdp-smoke.mjs
$env:OUT = "out/screen.png"; node out/rdp-smoke.mjs                         # 画面の PNG ができる
```

- GCC のヘッダーの `00` が 1 バイト抜けていたのを、xrdp が 23 バイト決め打ちで読むことで見つけた(実際のクライアントのバイト列と突き合わせる試験を書いたつもりが、実装に合わせて試験を直していた)
- xrdp は LICENSE_REQUEST を返す。試験では `dummyLicense` で答える(Windows は「ライセンス不要」を返すので本番では要らない)
- 16 ビット色 + Interleaved RLE で、Xfce の画面が正しく描けた
