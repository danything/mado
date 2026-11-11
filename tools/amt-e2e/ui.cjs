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

const PASSWORD = "P@ssw0rd!";
const AMT = 'label.target:has(input[value="z440-amt"])';

async function newPage(browser) {
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
  return page;
}

/** 「開く」を押して、AMT の画面が出るまで待つ */
async function openAmt(page) {
  await page.click("button[type=submit]");
  await page
    .waitForSelector("#amt:not([hidden])", { timeout: 10000 })
    .catch(async (e) => {
      console.log(`status: ${await page.textContent("#status")}`);
      throw e;
    });
}

async function closeAmt(page) {
  await page.click('#amt button[data-amt="close"]');
  await page.waitForSelector("#home:not([hidden])");
}

/** 保存の欄の様子 */
const saveState = (page) =>
  page.evaluate(() => ({
    shown: !document.querySelector("#save-field").hidden,
    checked: document.querySelector("input[name=save]").checked,
    forget: !document.querySelector("#forget").hidden,
    password: document.querySelector("input[name=password]").value,
    note: document.querySelector("#save-note").textContent,
  }));

/** 保存の欄がその様子になるまで待つ(保存は IndexedDB から読むので、少し遅れて映る) */
async function waitSave(page, want) {
  await page
    .waitForFunction(
      (w) => {
        const now = {
          shown: !document.querySelector("#save-field").hidden,
          checked: document.querySelector("input[name=save]").checked,
          forget: !document.querySelector("#forget").hidden,
          password: document.querySelector("input[name=password]").value,
        };
        return Object.entries(w).every(([k, v]) => now[k] === v);
      },
      want,
      { timeout: 5000 },
    )
    .catch(async () => {
      throw new Error(
        `保存の欄: ${JSON.stringify(await saveState(page))}(期待 ${JSON.stringify(want)})`,
      );
    });
}

/** IndexedDB に置いてあるものをそのまま読む。鍵は取り出せるかも試す */
const stored = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("mado-logins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = (store, keys) =>
      new Promise((resolve, reject) => {
        const s = db.transaction(store).objectStore(store);
        const r = keys ? s.getAllKeys() : s.getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    try {
      const names = [...db.objectStoreNames];
      if (!names.includes("logins")) return { ids: [], keys: 0, text: "" };
      const keys = await all("keys");
      const logins = await all("logins");
      let exported = "取り出せない";
      if (keys[0])
        await crypto.subtle.exportKey("raw", keys[0]).then(
          () => (exported = "取り出せた"),
          () => {},
        );
      return {
        ids: await all("logins", true),
        keys: keys.length,
        extractable: keys[0]?.extractable,
        exported,
        // 置いてあるバイトを字として読んだもの(平文が混じっていないかを見る)
        text: logins
          .map(
            (l) =>
              Object.keys(l).join() +
              String.fromCharCode(...new Uint8Array(l.data)),
          )
          .join("|"),
      };
    } finally {
      db.close();
    }
  });

/**
 * 保存が使えないブラウザ。http の mado.test は安全な文脈ではないので、そのままの Chromium には WebCrypto(crypto.subtle)が無い。
 * 保存のチェックは出ず、つなぐのは今までどおりできる
 */
async function withoutStorage() {
  const browser = await chromium.launch();
  const page = await newPage(browser);
  await page.click(AMT);
  await page.waitForTimeout(300);
  const s = await saveState(page);
  if (s.shown) throw new Error("保存が使えないのにチェックが出ている");
  await page.fill("input[name=password]", PASSWORD);
  await openAmt(page);
  await closeAmt(page);
  if ((await page.inputValue("input[name=password]")) !== "")
    throw new Error("保存が使えないのにパスワードが残っている");
  console.log("保存が使えないブラウザ: チェックは出ず、AMT は開ける");
  await browser.close();
}

(async () => {
  await withoutStorage();
  // ここからは保存が使えるブラウザ(本番は https。試験の http の先を安全な文脈として扱わせる)。
  // 既定の headless shell はこの指定を聞かないので、ふつうの Chromium(新しい headless)で動かす
  const browser = await chromium.launch({
    channel: "chromium",
    args: [`--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`],
  });
  const page = await newPage(browser);
  // 丸いラジオは隠してあるので、行を押す
  await page.click(AMT);
  const label = await page.textContent("#username-label");
  const username = await page.inputValue("input[name=username]");
  console.log(`欄: ${label} / ${username}`);
  // 保存のチェックは出ていて、既定はオフ。保存が無いので「保存を消去」は出ない
  await waitSave(page, { shown: true, checked: false, forget: false });
  // 枠の色が変わり終わるのを待つ
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/src/out/amt-home.png" });
  // 違うパスワードは、チェックを入れていても保存しない(保存はつながったあと)
  await page.fill("input[name=password]", "wrong");
  await page.check("input[name=save]");
  await page.click("button[type=submit]");
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("違います"),
  );
  await page.waitForSelector("button[type=submit]:not([aria-busy])");
  if ((await stored(page)).ids.length)
    throw new Error("違うパスワードを保存した");
  await waitSave(page, { forget: false, password: "" });
  console.log("違うパスワード: 保存しない");
  // チェックを入れてつながると保存する
  await page.fill("input[name=password]", PASSWORD);
  await page.check("input[name=save]");
  await openAmt(page);
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
  // 「電源オン」は 1 回押しで実行する(動いている PC に影響しないので、聞き返さない)。
  // 1 度押しただけで受け付けられ、電源が入って、ボタンが入れ替わる
  const powerOn = async () => {
    await page.click('#amt-actions button[data-power="2"]');
    await page.waitForFunction(
      () =>
        document.querySelector("#amt-status")?.textContent ===
        "電源オン: 受け付けました",
      null,
      { timeout: 2500 },
    );
    if (await page.$("#amt-actions button[data-armed]"))
      throw new Error("電源オンが 2 回目を待っている");
    await page.waitForFunction(
      () =>
        document.querySelector("#amt-state")?.textContent?.includes("オン") &&
        ![...document.querySelectorAll("#amt-actions button")].some(
          (b) => b.textContent === "電源オン",
        ),
      null,
      { timeout: 10000 },
    );
    console.log(
      `電源オン: 1 回押しで ${await page.textContent("#amt-status")}`,
    );
  };
  // 前の試験で切れたままなら、先に入れる
  if (!on) await powerOn();
  // 動いている PC に影響する操作は 2 回押しのまま
  const power = '#amt-actions button[data-power="8"]';
  const powerLabel = "強制電源オフ";
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
    () => document.querySelector("#amt-state")?.textContent?.includes("オフ"),
    null,
    { timeout: 10000 },
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#amt-actions button")].some(
      (b) => b.textContent === "電源オン",
    ),
  );
  console.log(
    `操作のあとの電源: ${await page.textContent("#amt-state")}・ボタン: ${(
      await page.$$eval("#amt-actions button", (bs) =>
        bs.map((b) => b.textContent),
      )
    ).join(" / ")}`,
  );
  await page.screenshot({ path: "/src/out/amt-view.png" });
  // 切れているので「電源オン」だけが出ている。1 回押しで入る
  await powerOn();
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
  await closeAmt(page);

  // ---- ユーザー名とパスワードの保存 ----
  // つながったので保存してある。戻ると欄に入っていて、チェックが入り、「保存を消去」が出る
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  // 欄の名前が上に寄り終わるのを待つ
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/src/out/amt-home-saved.png" });
  // 置いてあるのは暗号化したものと、取り出せない鍵。平文は無い
  let db = await stored(page);
  console.log(
    `保存: ${db.ids.join()}・鍵 ${db.keys} 本(extractable=${db.extractable}、${db.exported})`,
  );
  if (db.ids.join() !== "amt:z440-amt") throw new Error("保存した先が違う");
  if (db.extractable !== false || db.exported !== "取り出せない")
    throw new Error("鍵を取り出せる");
  if (db.text.includes(PASSWORD) || db.text.includes("admin"))
    throw new Error("平文のまま置いてある");
  // ほかの先には持ち越さない。Talos では欄ごと出ず、RDP の先は空のまま
  await page.click('label.target:has(input[value="z440-talos"])');
  await waitSave(page, { shown: false });
  await page.click('label.target:has(input[value="pc"])');
  await waitSave(page, {
    shown: true,
    checked: false,
    forget: false,
    password: "",
  });
  await page.click(AMT);
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  // 開き直しても入っている。自動ではつながず、「開く」を押すとそのままつながる
  await page.reload();
  await page.waitForSelector("#home:not([hidden])");
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  if (!(await page.isHidden("#amt")))
    throw new Error("保存があると自動でつないだ");
  await openAmt(page);
  await closeAmt(page);
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  console.log("保存: 開き直しても欄に入り、押すとつながる");
  // 保存したパスワードが合わなくなったとき(AMT のパスワードを変えたあと)。
  // このページの中のスクリプトは鍵を使えるので、違うパスワードを同じ鍵で暗号化して置き換えて作る
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("mado-logins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const key = await new Promise((resolve, reject) => {
      const r = db.transaction("keys").objectStore("keys").get("logins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode("amt:z440-amt") },
      key,
      enc.encode(JSON.stringify({ username: "admin", password: "stale" })),
    );
    await new Promise((resolve, reject) => {
      const t = db.transaction("logins", "readwrite");
      t.objectStore("logins").put({ iv, data }, "amt:z440-amt");
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    db.close();
  });
  await page.reload();
  await page.waitForSelector("#home:not([hidden])");
  await waitSave(page, { checked: true, forget: true, password: "stale" });
  // 断られたら 1 度でやめ、欄には入れ直さない(同じものをもう一度送らせない)。保存は残り、消すか上書きできる
  const wsman = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/wsman")) wsman.push(1);
  });
  await page.click("button[type=submit]");
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("違います"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#save-note")
      ?.textContent?.includes("保存したパスワードでは認証できませんでした"),
  );
  await waitSave(page, { checked: true, forget: true, password: "" });
  await page.waitForTimeout(1000);
  // Digest は 1 度目に nonce をもらい、2 度目に応答を送る。断られたあとは送らない
  if (wsman.length > 2)
    throw new Error(`断られたあとも試した(${wsman.length} 回)`);
  console.log(
    `保存したもので断られた: ${await page.textContent("#save-note")}(AMT へ ${wsman.length} 回)`,
  );
  await page.screenshot({ path: "/src/out/amt-home-rejected.png" });
  // 入力し直してつながると、上書きする
  await page.fill("input[name=password]", PASSWORD);
  await openAmt(page);
  await closeAmt(page);
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  console.log("保存: 入力し直してつながると上書きする");
  // 「保存を消去」で、その先の保存を消す
  await page.click("#forget");
  await waitSave(page, { checked: false, forget: false, password: "" });
  if ((await page.textContent("#save-note")) !== "保存を消去しました")
    throw new Error("消したことが出ない");
  if ((await stored(page)).ids.length) throw new Error("保存が残っている");
  console.log(`保存を消去: ${await page.textContent("#save-note")}`);
  // チェックを外してつなぐと、前の保存を消す
  await page.fill("input[name=password]", PASSWORD);
  await page.check("input[name=save]");
  await openAmt(page);
  await closeAmt(page);
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });
  await page.uncheck("input[name=save]");
  await openAmt(page);
  await closeAmt(page);
  await waitSave(page, { checked: false, forget: false, password: "" });
  if ((await stored(page)).ids.length)
    throw new Error("チェックを外してつないでも保存が残っている");
  console.log("保存: チェックを外してつなぐと消える");
  // あとでログアウトを試すので、もう一度保存しておく
  await page.fill("input[name=password]", PASSWORD);
  await page.check("input[name=save]");
  await openAmt(page);
  await closeAmt(page);
  await waitSave(page, { checked: true, forget: true, password: PASSWORD });

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
  // 終わった直後(0.5 秒)は押せず、そのあと「もう一度開く」に焦点を置く(Enter で開き直せる)
  if (!(await page.isDisabled("#talos-reopen")))
    throw new Error("終わった直後から「もう一度開く」を押せる");
  await page.waitForSelector("#talos-reopen:not([disabled])");
  await page.waitForTimeout(50);
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

  // 電源の操作: バーにシャットダウンと再起動。AMT と同じ 2 回押しで確定する
  const talosPower = await page.$$eval("#talos-actions button", (bs) =>
    bs.map((b) => `${b.textContent}(${b.title})`),
  );
  console.log(`Talos の電源のボタン: ${talosPower.join(" / ")}`);
  if (talosPower.length !== 2)
    throw new Error("Talos の電源のボタンが 2 つでない");
  const powerPosts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/talos/"))
      powerPosts.push(new URL(r.url()).pathname);
  });
  const rebootButton = '#talos-actions button[data-power="reboot"]';
  await page.click(rebootButton);
  await page.waitForFunction(
    () =>
      document.querySelector("#talos-status")?.textContent ===
      "もう一度押すと再起動します",
  );
  if ((await page.textContent(rebootButton)) !== "もう一度押すと再起動")
    throw new Error("Talos: 1 回目でボタンの文が変わらない");
  await page.mouse.move(0, 400);
  await page.waitForTimeout(300);
  console.log(
    `Talos の 1 回目: 字の色 ${await page.$eval(rebootButton, (b) => getComputedStyle(b).color)}`,
  );
  await page.screenshot({ path: "/src/out/talos-power-armed.png" });
  // 3 秒たつと戻る(ダブルクリックとキーの押しっぱなしは AMT と同じ部品で、上の AMT の試験で見る)
  await page.waitForTimeout(3300);
  if (powerPosts.length) throw new Error("Talos: 1 回目で頼んだ");
  if ((await page.textContent(rebootButton)) !== "再起動")
    throw new Error("Talos: 3 秒たってもボタンの文が戻らない");
  // キーボードで 2 回押すと頼む。Linux の mado は talosctl を動かせないので、失敗の理由がバーに出る
  await page.focus(rebootButton);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document
        .querySelector("#talos-status")
        ?.textContent?.startsWith("再起動できませんでした"),
    null,
    { timeout: 10000 },
  );
  if (powerPosts.join() !== "/api/talos/z440-talos/reboot")
    throw new Error(`Talos: 頼んだもの ${powerPosts.join()}`);
  console.log(`Talos の電源: ${await page.textContent("#talos-status")}`);
  await page.screenshot({ path: "/src/out/talos-power.png" });
  await page.click('#talos button[data-talos="close"]');
  await page.waitForSelector("#home:not([hidden])");
  if (!(await page.isHidden("#talos")))
    throw new Error("閉じてもダッシュボードの画面が残っている");
  // 暗いテーマのつなぐ前の画面
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/src/out/amt-home-dark.png" });
  // ログアウトすると、保存したものと鍵をこの端末から消してから /logout に移る
  db = await stored(page);
  if (db.ids.join() !== "amt:z440-amt" || db.keys !== 1)
    throw new Error("ログアウトの前の保存が無い");
  await page.click("#logout");
  await page.waitForURL(`${ORIGIN}/logout`);
  db = await stored(page);
  if (db.ids.length || db.keys)
    throw new Error("ログアウトしても保存が残っている");
  console.log(`ログアウト: ${await page.textContent("body")}・保存は空`);
  console.log("ui: すべて通った");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
