// test.html を headless の Chromium で開き、ログを出す。Playwright の像の中で動かす。
// 使い方: node headless.cjs http://wtpoc:8080 https://wtpoc:4433/wt
// http://wtpoc は安全な文脈でないので、その origin を安全とみなす旗を付ける。
const { chromium } = require("playwright");

const page_ = process.argv[2] || "http://wtpoc:8080";
const wt = process.argv[3] || "https://wtpoc:4433/wt";

(async () => {
  const browser = await chromium.launch({
    channel: "chromium", // headless shell には WebTransport が無いことがある
    args: [`--unsafely-treat-insecure-origin-as-secure=${page_}`],
  });
  console.log(`browser ${browser.version()}`);
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`[console] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
  await page.goto(`${page_}/?auto=1&url=${encodeURIComponent(wt)}`);
  console.log(`secure=${await page.evaluate(() => isSecureContext)} WebTransport=${await page.evaluate(() => typeof WebTransport)}`);
  try {
    await page.waitForFunction(() => /close を送った|ready で失敗|誤り/.test(document.getElementById("log").textContent), null, { timeout: 30000 });
  } catch {
    console.log("時間切れ");
  }
  await page.waitForTimeout(1000);
  await browser.close();
})();
