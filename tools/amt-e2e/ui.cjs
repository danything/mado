// AMT の画面を headless の Chromium で開いて、電源の状態と SOL の端末、重ねるバーの出し入れを見る。画面は out/ に PNG で残す。
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
  // Talos のダッシュボードはトップの一覧から開く。AMT の画面には出さない
  if (await page.$("#amt-dash, #amt [data-amt=dash]"))
    throw new Error("AMT の画面にダッシュボードのボタンが残っている");
  // 開くとすぐ SOL につなぐ。バーは常に出ている
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
  // 触らなくてもバーは引っ込まない
  await page.waitForTimeout(6000);
  if (!(await page.isVisible("#amt-bar[data-shown] #amt-actions button")))
    throw new Error("SOL のバーが引っ込んだ");
  await page.screenshot({ path: "/src/out/amt-sol.png" });
  // 電源の操作はいま使えるものだけバーに並ぶ。入っていれば電源オンは出ない
  const on = (await page.textContent("#amt-state")).includes("オン");
  const shown = await page.$$eval("#amt-actions button", (bs) =>
    bs.map((b) => b.textContent),
  );
  console.log(`電源のボタン: ${shown.join(" / ")}`);
  if (on === shown.includes("電源オン"))
    throw new Error("電源の状態と出ているボタンが合わない");
  const power = `#amt-actions button[data-power="${on ? 8 : 2}"]`;
  const powerLabel = on ? "強制電源オフ" : "電源オン";
  // 1 回目で文が変わり、3 秒押さなければ元に戻る
  await page.click(power);
  await page.waitForFunction(
    (want) =>
      document.querySelector("#amt-status")?.textContent ===
      `もう一度押すと${want}します`,
    powerLabel,
  );
  if ((await page.textContent(power)) !== `もう一度押すと${powerLabel}`)
    throw new Error("1 回目でボタンの文が変わらない");
  // 乗せていなくても、待っている間は赤い字(色の移り変わりを待つ)
  await page.mouse.move(0, 400);
  await page.waitForTimeout(300);
  const color = await page.$eval(power, (b) => getComputedStyle(b).color);
  console.log(`1 回目: ${await page.textContent(power)}(字の色 ${color})`);
  await page.screenshot({ path: "/src/out/amt-power-armed.png" });
  await page.waitForTimeout(3300);
  if ((await page.textContent(power)) !== powerLabel)
    throw new Error("3 秒たってもボタンの文が戻らない");
  // 別のボタンを押すと待ちは取り消す(キーボードで 1 回目、SOL のボタンを押す)
  await page.focus(power);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${power}[data-armed]`);
  await page.click("#amt-sol");
  if (await page.$(`${power}[data-armed]`))
    throw new Error("別のボタンを押しても待ちが残る");
  await page.waitForFunction(() =>
    document.querySelector("#amt-sol")?.textContent?.includes("接続"),
  );
  // SOL を切ったなら、つなぎ直す
  if ((await page.textContent("#amt-sol")).includes("SOL に接続"))
    await page.click("#amt-sol");
  // つなぎ終わると焦点が端末へ移るので、それを待ってからボタンに戻す
  await page.waitForFunction(
    () => document.querySelector("#amt-sol")?.textContent?.includes("切断"),
    null,
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);
  // キーボードで 2 回押すと実行する
  await page.focus(power);
  await page.keyboard.press("Enter");
  // すぐの 2 回目(ダブルクリック)は受けない
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  if (!(await page.$(`${power}[data-armed]`)))
    throw new Error("すぐの 2 回目で実行された");
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () =>
      document
        .querySelector("#amt-status")
        ?.textContent?.includes("受け付けました"),
    null,
    { timeout: 10000 },
  );
  // 操作の 3 秒あとに読み直し、ボタンが入れ替わる
  await page.waitForFunction(
    (want) => document.querySelector("#amt-state")?.textContent?.includes(want),
    on ? "オフ" : "オン",
    { timeout: 10000 },
  );
  await page.waitForFunction(
    (wasOn) =>
      [...document.querySelectorAll("#amt-actions button")].some(
        (b) => b.textContent === "電源オン",
      ) === wasOn,
    on,
  );
  console.log(
    `操作のあとの電源: ${await page.textContent("#amt-state")}・ボタン: ${(
      await page.$$eval("#amt-actions button", (bs) =>
        bs.map((b) => b.textContent),
      )
    ).join(" / ")}`,
  );
  await page.screenshot({ path: "/src/out/amt-view.png" });
  // IDE-R: 「ISO から起動」で ISO を選ぶと、確認の窓のあと、受け付けたと出る
  const iso = Buffer.alloc(64 * 2048);
  for (let i = 0; i < iso.length; i++) iso[i] = ((i >> 11) + i) % 251;
  await page.setInputFiles("#ider-file", {
    name: "talos-metal-amd64.iso",
    mimeType: "application/octet-stream",
    buffer: iso,
  });
  await page.waitForSelector("#confirm[open]");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/src/out/ider-confirm.png" });
  await page.click('#confirm button[value="ok"]');
  await page.waitForFunction(
    () =>
      /リセットを受け付け|電源オンを受け付け|IDE-R [0-9.]+ MB|IDE-R を終了/.test(
        document.querySelector("#amt-status")?.textContent ?? "",
      ),
    null,
    { timeout: 15000 },
  );
  console.log(`IDE-R: ${await page.textContent("#amt-status")}`);
  await page.screenshot({ path: "/src/out/ider.png" });
  await page.click('#amt button[data-amt="close"]');
  await page.waitForSelector("#home:not([hidden])");

  // Talos のダッシュボード: 一覧で選ぶとユーザー名とパスワードの欄が隠れ、ボタンは「開く」。
  // 押すとすぐ画面いっぱいの端末になり、/ws/talos につなぐ。Linux の mado は ConPTY が無いので、
  // talosctl を動かすところで閉じ、その理由と「もう一度開く」が出る
  const talosSockets = [];
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).pathname === "/ws/talos") talosSockets.push(ws);
  });
  await page.click('label.target:has(input[value="z440-talos"])');
  if (
    (await page.isVisible("input[name=username]")) ||
    (await page.isVisible("input[name=password]"))
  )
    throw new Error("Talos の先でユーザー名とパスワードの欄が出ている");
  const open = (await page.textContent("button[type=submit]")).trim();
  if (open !== "開く") throw new Error(`Talos の先のボタンが「${open}」`);
  console.log(`Talos の先: ${open}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/src/out/talos-home.png" });
  await page.click("button[type=submit]");
  await page.waitForSelector("#talos:not([hidden])", { timeout: 10000 });
  if (!(await page.isHidden("#home")))
    throw new Error("ダッシュボードを開いても一覧が残っている");
  await page.waitForFunction(
    () =>
      document
        .querySelector("#talos-term .xterm-rows")
        ?.textContent?.includes("Windows"),
    null,
    { timeout: 10000 },
  );
  if (talosSockets.length !== 1)
    throw new Error(`/ws/talos につないだ数が ${talosSockets.length}`);
  await page.waitForSelector("#talos-reopen:not([hidden])");
  // 終わったら「もう一度開く」に焦点を置く(Enter で開き直せる)
  if (!(await page.$eval("#talos-reopen", (b) => b === document.activeElement)))
    throw new Error("「もう一度開く」に焦点が無い");
  console.log(
    `Talos: ${await page.textContent("#talos-name")}・${await page.textContent("#talos-status")}`,
  );
  // 隠れた入力欄は SOL と同じく画面の外で、書く手伝いを切ってある
  const ta = await page.$eval("#talos-term .xterm-helper-textarea", (t) => ({
    left: t.getBoundingClientRect().left,
    writing: t.getAttribute("writingsuggestions"),
  }));
  if (ta.left >= 0 || ta.writing !== "false")
    throw new Error(`隠れた入力欄: ${JSON.stringify(ta)}`);
  await page.screenshot({ path: "/src/out/talos.png" });
  await page.keyboard.press("Enter");
  for (let i = 0; i < 50 && talosSockets.length < 2; i++)
    await page.waitForTimeout(100);
  if (talosSockets.length !== 2)
    throw new Error("「もう一度開く」で /ws/talos につなぎ直さない");
  await page.waitForSelector("#talos-reopen:not([hidden])");
  await page.click('#talos button[data-talos="close"]');
  await page.waitForSelector("#home:not([hidden])");
  if (!(await page.isHidden("#talos")))
    throw new Error("閉じてもダッシュボードの画面が残っている");
  // 暗いテーマのつなぐ前の画面
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/src/out/amt-home-dark.png" });
  console.log("ui: すべて通った");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
