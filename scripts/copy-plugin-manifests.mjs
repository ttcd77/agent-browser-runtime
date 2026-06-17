import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const pluginsDir = join(process.cwd(), "src", "plugins");
const entries = await readdir(pluginsDir, { withFileTypes: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyFileWithWindowsRetry(src, dst) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await copyFile(src, dst);
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastError;
}

let copied = 0;
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const src = join(pluginsDir, entry.name, "plugin.json");
  const dstDir = join(process.cwd(), "dist", "plugins", entry.name);
  const dst = join(dstDir, "plugin.json");
  try {
    await mkdir(dstDir, { recursive: true });
    await copyFileWithWindowsRetry(src, dst);
    copied += 1;
    console.log(`copied ${entry.name}/plugin.json`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

console.log(`Done. ${copied} plugin manifest(s) copied to dist/.`);
