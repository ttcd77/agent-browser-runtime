import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLocalBrowserProfile,
  readLeaseState,
  writeLeaseState,
  type BrowserProfileLeaseState,
} from "./lease-store.js";

const tempDirs: string[] = [];

function tempLeaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdp-profile-lease-"));
  tempDirs.push(dir);
  return join(dir, "leases.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("browser profile lease store", () => {
  it("leases the first available profile", () => {
    const leaseFile = tempLeaseFile();
    const result = acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a", "demo-payer"],
      caller_label: "agent-a",
      leaseFile,
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      target: "demo",
      profile_name: "demo-merchant-a",
      ttl_seconds: 1800,
    });
    expect(readLeaseState(leaseFile).leases["demo-merchant-a"]?.caller_label).toBe("agent-a");
  });

  it("skips active leases and picks the next profile", () => {
    const leaseFile = tempLeaseFile();
    acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a", "demo-payer"],
      caller_label: "agent-a",
      leaseFile,
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    const result = acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a", "demo-payer"],
      caller_label: "agent-b",
      leaseFile,
      now: new Date("2026-05-15T10:01:00.000Z"),
    });

    expect(result).toMatchObject({
      target: "demo",
      profile_name: "demo-payer",
    });
  });

  it("reuses an expired lease", () => {
    const leaseFile = tempLeaseFile();
    const state: BrowserProfileLeaseState = {
      leases: {
        "demo-merchant-a": {
          profile: "demo-merchant-a",
          target: "demo",
          caller_label: "old-agent",
          acquired_at: "2026-05-15T09:00:00.000Z",
          expires_at: "2026-05-15T09:30:00.000Z",
        },
      },
    };
    writeLeaseState(state, leaseFile);

    const result = acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a"],
      caller_label: "new-agent",
      leaseFile,
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      profile_name: "demo-merchant-a",
    });
    expect(readLeaseState(leaseFile).leases["demo-merchant-a"]?.caller_label).toBe("new-agent");
  });

  it("returns pool_exhausted when every profile is actively leased", () => {
    const leaseFile = tempLeaseFile();
    acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a"],
      caller_label: "agent-a",
      leaseFile,
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    const result = acquireLocalBrowserProfile({
      target: "demo",
      pool: ["demo-merchant-a"],
      caller_label: "agent-b",
      leaseFile,
      now: new Date("2026-05-15T10:01:00.000Z"),
    });

    expect(result).toMatchObject({
      error: "pool_exhausted",
      target: "demo",
      pool: ["demo-merchant-a"],
      active_leases: [
        expect.objectContaining({
          profile: "demo-merchant-a",
          caller_label: "agent-a",
        }),
      ],
    });
  });
});
