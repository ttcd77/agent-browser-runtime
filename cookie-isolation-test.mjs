// Verify cookie isolation between two spawned profiles.
// Set cookie in A, then GET /cookies endpoint from B — should not contain A's cookie.
import WebSocket from "ws";

async function setupTab(port, url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await new Promise((r) => setTimeout(r, 3000));  // wait for httpbin to load
  return { ws, send };
}

// A: set a distinctive cookie
const a = await setupTab(9300, "https://httpbin.org/cookies/set?ISOLATION_TEST_A=secret_from_A&path=/");
await new Promise((r) => setTimeout(r, 2000));
const aRead = await a.send("Runtime.evaluate", { expression: "JSON.stringify({cookies:document.cookie, url:location.href})", returnByValue: true });
console.log("[A] after set:", aRead?.result?.result?.value);
a.ws.close();

// B: open httpbin /cookies — should NOT see A's cookie
const b = await setupTab(9301, "https://httpbin.org/cookies");
await new Promise((r) => setTimeout(r, 2000));
const bRead = await b.send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
console.log("\n[B] /cookies endpoint response:");
console.log(bRead?.result?.result?.value || "(no body)");
const bCookieDom = await b.send("Runtime.evaluate", { expression: "document.cookie", returnByValue: true });
console.log("\n[B] document.cookie:", bCookieDom?.result?.result?.value || "(empty)");
b.ws.close();

console.log("\n=== ISOLATION VERDICT ===");
const bBody = bRead?.result?.result?.value || "";
const bDom = bCookieDom?.result?.result?.value || "";
if (bBody.includes("ISOLATION_TEST_A") || bDom.includes("ISOLATION_TEST_A")) {
  console.log("❌ FAIL — A's cookie leaked to B");
  process.exit(1);
} else {
  console.log("✅ PASS — A's cookie ISOLATED from B (different user-data-dirs)");
  process.exit(0);
}
