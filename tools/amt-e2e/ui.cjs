// AMT の画面を headless の Chromium で開いて、電源の状態と SOL の端末が出ることを見る。画面は out/ に PNG で残す。
// e2e.ts と同じく、偽の AMT(amt.test)と mado(mado.test)が amtnet にいること。
//   wslc run --rm --network amtnet -v "<リポジトリ>:/src" -w /tmp mcr.microsoft.com/playwright:v1.64.1-noble \
//     sh -c "npm i playwright@1.64.1 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /src/tools/amt-e2e/ui.cjs"
const { chromium } = require("playwright");
const crypto = require("node:crypto");

const ORIGIN = "http://mado.test:8080";
const KEY = Buffer.alloc(32, 1);
const sign = (v) => {
  const body = Buffer.from(
    JSON.stringify({ ...v, exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", KEY).update(body).digest("base64url")}`;
};

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
  });
  await context.addCookies([
    { name: "mado", value: sign({ sub: "u1", name: "e2e" }), url: ORIGIN },
  ]);
  const page = await context.newPage();
  page.on("console", (m) => console.log(`console: ${m.text()}`));
  await page.goto(ORIGIN);
  await page.waitForSelector("#home:not([hidden])");
  // 丸いラジオは隠してあるので、行を押す
  await page.click('label.target:has(input[value="z440-amt"])');
  const label = await page.textContent("#username-label");
  const username = await page.inputValue("input[name=username]");
  console.log(`欄: ${label} / ${username}`);
  // 枠の色が変わり終わるのを待つ
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/src/out/amt-home.png" });
  await page.fill("input[name=password]", "P@ssw0rd!");
  await page.click("button[type=submit]");
  await page
    .waitForSelector("#amt:not([hidden])", { timeout: 10000 })
    .catch(async (e) => {
      console.log(`status: ${await page.textContent("#status")}`);
      throw e;
    });
  console.log(`電源: ${await page.textContent("#amt-state")}`);
  await page.click("#amt-sol");
  await page.waitForFunction(
    () => document.querySelector("#sol")?.textContent?.includes("Talos"),
    null,
    { timeout: 10000 },
  );
  await page.keyboard.type("hello");
  await page.waitForFunction(
    () => document.querySelector("#sol")?.textContent?.includes("HELLO"),
    null,
    { timeout: 10000 },
  );
  // 電源を切る(切れていれば入れる): 確かめる窓が出る。危ない操作では、やめるにフォーカスがある
  const on = (await page.textContent("#amt-state")).includes("オン");
  await page.click(`#amt-actions button[data-power="${on ? 8 : 2}"]`);
  await page.waitForSelector("#confirm[open]");
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute("value"),
  );
  console.log(`確かめる窓のフォーカス: ${focused}`);
  // 窓が開き終わるのを待つ
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/src/out/amt-confirm.png" });
  await page.click('#confirm button[value="ok"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector("#amt-status")
        ?.textContent?.includes("受け付けました"),
    null,
    { timeout: 10000 },
  );
  await page.click('#amt button[data-amt="refresh"]');
  await page.waitForFunction(
    (want) => document.querySelector("#amt-state")?.textContent?.includes(want),
    on ? "オフ" : "オン",
    { timeout: 10000 },
  );
  console.log(`操作のあとの電源: ${await page.textContent("#amt-state")}`);
  await page.screenshot({ path: "/src/out/amt-view.png" });
  // IDE-R: ISO を選んで起動する。確認の窓のあと、受け付けたと出る
  const iso = Buffer.alloc(64 * 2048);
  for (let i = 0; i < iso.length; i++) iso[i] = ((i >> 11) + i) % 251;
  await page.setInputFiles("#ider-file", {
    name: "talos-metal-amd64.iso",
    mimeType: "application/octet-stream",
    buffer: iso,
  });
  await page.click("#ider-boot");
  await page.waitForSelector("#confirm[open]");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/src/out/ider-confirm.png" });
  await page.click('#confirm button[value="ok"]');
  await page.waitForFunction(
    () =>
      /受け付けました|終了しました/.test(
        document.querySelector("#ider-status")?.textContent ?? "",
      ),
    null,
    { timeout: 15000 },
  );
  console.log(`IDE-R: ${await page.textContent("#ider-status")}`);
  await page.screenshot({ path: "/src/out/ider.png" });
  await page.click('#amt button[data-amt="close"]');
  await page.waitForSelector("#home:not([hidden])");
  // 暗いテーマのつなぐ前の画面
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/src/out/amt-home-dark.png" });
  console.log("ui: すべて通った");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
