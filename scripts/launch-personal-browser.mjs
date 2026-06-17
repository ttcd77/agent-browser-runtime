import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function browserExecutable() {
  if (process.env.CDP_BROWSER_EXECUTABLE) return process.env.CDP_BROWSER_EXECUTABLE;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  return candidates.find((candidate) => existsSync(candidate));
}

const executable = browserExecutable();
if (!executable) {
  throw new Error("No Edge/Chrome executable found. Set CDP_BROWSER_EXECUTABLE.");
}

const port = process.env.CDP_BROWSER_PORT || "9222";
const userDataDir =
  process.env.CDP_BROWSER_USER_DATA_DIR ||
  join(homedir(), ".agent-browser-runtime", "personal-browser");
const url = process.argv[2] || "about:blank";

mkdirSync(userDataDir, { recursive: true });

const child = spawn(
  executable,
  [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ],
  {
    detached: true,
    stdio: "ignore",
  },
);
child.unref();

console.log("Personal debugging browser launched:");
console.log(`- executable: ${executable}`);
console.log(`- CDP endpoint: http://127.0.0.1:${port}`);
console.log(`- user data dir: ${userDataDir}`);
console.log(`- initial url: ${url}`);
