// 画面をビルドして dist/web を作る。bun run build:web で呼ぶ。dist/web は exe に埋め込まれ、ハッシュ入りの名前のものは 1 年キャッシュされる。
// RemoteFX を復号する Worker は HTML のビルドでは束ねられない。先に別に束ねて、できたファイル名を画面のビルドに定数で渡す。

import { rm } from "node:fs/promises";
import { basename } from "node:path";

await rm("dist/web", { recursive: true, force: true });

// 1. Worker。名前に内容のハッシュを入れるので、中身が変われば名前も変わる
const worker = await Bun.build({
  entrypoints: ["web/rdp/rfx.worker.ts"],
  outdir: "dist/web",
  minify: true,
  naming: "[name]-[hash].[ext]",
});
const workerFile = worker.outputs.find((o) => o.kind === "entry-point");
if (!worker.success || !workerFile) {
  for (const log of worker.logs) console.error(log);
  throw new Error("Worker のビルドに失敗");
}

// 2. 画面。rfxpool.ts の __RFX_WORKER__ が Worker の URL になる
const page = await Bun.build({
  entrypoints: ["web/index.html"],
  outdir: "dist/web",
  minify: true,
  define: { __RFX_WORKER__: JSON.stringify(`/${basename(workerFile.path)}`) },
});
if (!page.success) {
  for (const log of page.logs) console.error(log);
  throw new Error("画面のビルドに失敗");
}

for (const o of [...worker.outputs, ...page.outputs])
  console.log(`${basename(o.path)}  ${(o.size / 1024).toFixed(1)} KB`);
