import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "oc-cdp-product-smoke-"));

try {
  await import(pathToFileURL(join(root, "dist/plugins/cdp-traffic-capture/index.js")).href);
  await import(pathToFileURL(join(root, "dist/plugins/browser-profile-pool/index.js")).href);
  const leaseStore = await import(
    pathToFileURL(join(root, "dist/plugins/browser-profile-pool/lease-store.js")).href
  );

  const leaseFile = join(tempDir, "profile-leases.json");
  const first = leaseStore.acquireLocalBrowserProfile({
    target: "demo",
    pool: ["demo-buyer", "demo-seller"],
    caller_label: "product-smoke-agent-a",
    leaseFile,
    now: new Date("2026-05-15T12:00:00.000Z"),
  });
  assert(first.profile_name === "demo-buyer", "expected first lease to use demo-buyer");

  const second = leaseStore.acquireLocalBrowserProfile({
    target: "demo",
    pool: ["demo-buyer", "demo-seller"],
    caller_label: "product-smoke-agent-b",
    leaseFile,
    now: new Date("2026-05-15T12:01:00.000Z"),
  });
  assert(second.profile_name === "demo-seller", "expected second lease to skip occupied profile");

  const exhausted = leaseStore.acquireLocalBrowserProfile({
    target: "demo",
    pool: ["demo-buyer", "demo-seller"],
    caller_label: "product-smoke-agent-c",
    leaseFile,
    now: new Date("2026-05-15T12:02:00.000Z"),
  });
  assert(exhausted.error === "pool_exhausted", "expected third lease to report pool_exhausted");

  const reused = leaseStore.acquireLocalBrowserProfile({
    target: "demo",
    pool: ["demo-buyer", "demo-seller"],
    caller_label: "product-smoke-agent-d",
    leaseFile,
    now: new Date("2026-05-15T12:31:00.000Z"),
  });
  assert(reused.profile_name === "demo-buyer", "expected expired lease to be reusable");

  console.log("Product smoke passed:");
  console.log("- built plugin entrypoints can be imported");
  console.log("- profile identity leasing works without the old Hub service");
  console.log("- busy identities are skipped");
  console.log("- expired identities become available again");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
