// Connect directly to a spawned profile's CDP port, navigate to bot.sannysoft.com,
// capture screenshot + full table results.
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const PROFILE = process.argv[2] || "anti-bot-test-a";
const PORT = process.argv[3] || "9300";
const URL = "https://bot.sannysoft.com/";

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, { method: "PUT" })).json();
const wsUrl = targets.webSocketDebuggerUrl;
console.log(`[${PROFILE}] target id=${targets.id} ws=${wsUrl.slice(-40)}`);

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.once("open", r));

let id = 0;
const pending = new Map();
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await send("Page.enable");
await send("Runtime.enable");

// Wait for page to finish loading and JS bot-detection probes to run
await new Promise((r) => setTimeout(r, 8000));

// Grab the test table
const tableEval = await send("Runtime.evaluate", {
  expression: `(() => {
    const rows = [...document.querySelectorAll('table tr')].map((tr) => {
      const cells = [...tr.querySelectorAll('th, td')].map((c) => c.innerText.trim());
      return cells;
    });
    return JSON.stringify(rows, null, 2);
  })()`,
  returnByValue: true,
});

const fpProbes = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    webdriver: navigator.webdriver,
    headless: /headless/i.test(navigator.userAgent),
    userAgent: navigator.userAgent,
    chrome: !!window.chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages,
    vendor: navigator.vendor,
    automationControlled: navigator.webdriver === true,
  }, null, 2)`,
  returnByValue: true,
});

// Screenshot for visual evidence
const shot = await send("Page.captureScreenshot", { format: "png", fullPage: true });
const outPng = `C:\\Users\\Tong\\AppData\\Local\\Temp\\anti-bot-${PROFILE}.png`;
writeFileSync(outPng, Buffer.from(shot.result.data, "base64"));

console.log(`\n=== [${PROFILE}] FINGERPRINT PROBES ===`);
console.log(JSON.stringify(fpProbes, null, 2).slice(0, 400));
console.log("VALUE:", fpProbes?.result?.result?.value);
console.log(`\n=== [${PROFILE}] SANNYSOFT TABLE ===`);
console.log("VALUE:", tableEval?.result?.result?.value);
console.log(`\nScreenshot: ${outPng}`);

ws.close();
process.exit(0);
