import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_DATA_DIR = join(homedir(), ".agent-browser-runtime");

export const DEFAULT_PROFILE_LEASE_FILE =
  process.env.CDP_SECURITY_LEASE_FILE ||
  join(process.env.CDP_SECURITY_DATA_DIR || DEFAULT_DATA_DIR, "profile-leases.json");

export type BrowserProfileLease = {
  profile: string;
  target: string;
  caller_label: string;
  acquired_at: string;
  expires_at: string;
};

export type BrowserProfileLeaseState = {
  leases: Record<string, BrowserProfileLease>;
};

export type AcquireBrowserProfileResult =
  | {
      target: string;
      profile_name: string;
      lease: BrowserProfileLease;
      ttl_seconds: number;
      lease_file: string;
    }
  | {
      error: "pool_exhausted";
      target: string;
      pool: string[];
      active_leases: BrowserProfileLease[];
      ttl_seconds: number;
      lease_file: string;
    };

type AcquireBrowserProfileOptions = {
  target: string;
  pool: string[];
  ttl_seconds?: number;
  caller_label?: string;
  leaseFile?: string;
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTtlSeconds(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1800;
  return Math.max(1, Math.floor(raw));
}

function parseLease(value: unknown): BrowserProfileLease | undefined {
  if (!isRecord(value)) return undefined;
  const profile = value["profile"];
  const target = value["target"];
  const callerLabel = value["caller_label"];
  const acquiredAt = value["acquired_at"];
  const expiresAt = value["expires_at"];
  if (
    typeof profile !== "string" ||
    typeof target !== "string" ||
    typeof callerLabel !== "string" ||
    typeof acquiredAt !== "string" ||
    typeof expiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    profile,
    target,
    caller_label: callerLabel,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
  };
}

export function readLeaseState(leaseFile = DEFAULT_PROFILE_LEASE_FILE): BrowserProfileLeaseState {
  try {
    const raw = readFileSync(leaseFile, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed["leases"])) return { leases: {} };
    const leases: Record<string, BrowserProfileLease> = {};
    for (const [profile, lease] of Object.entries(parsed["leases"])) {
      const parsedLease = parseLease(lease);
      if (parsedLease) leases[profile] = parsedLease;
    }
    return { leases };
  } catch {
    return { leases: {} };
  }
}

export function writeLeaseState(
  state: BrowserProfileLeaseState,
  leaseFile = DEFAULT_PROFILE_LEASE_FILE,
): void {
  mkdirSync(dirname(leaseFile), { recursive: true });
  const tmp = `${leaseFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, leaseFile);
}

export function pruneExpiredLeases(
  state: BrowserProfileLeaseState,
  now = new Date(),
): BrowserProfileLeaseState {
  const nowMs = now.getTime();
  const leases: Record<string, BrowserProfileLease> = {};
  for (const [profile, lease] of Object.entries(state.leases)) {
    const expiresMs = Date.parse(lease.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
      leases[profile] = lease;
    }
  }
  return { leases };
}

export function acquireLocalBrowserProfile(
  options: AcquireBrowserProfileOptions,
): AcquireBrowserProfileResult {
  const target = options.target.trim();
  const pool = [...new Set(options.pool.map((name) => name.trim()).filter(Boolean))];
  const ttlSeconds = normalizeTtlSeconds(options.ttl_seconds);
  const callerLabel = options.caller_label?.trim() || "unknown";
  const leaseFile = options.leaseFile || DEFAULT_PROFILE_LEASE_FILE;
  const now = options.now || new Date();
  const state = pruneExpiredLeases(readLeaseState(leaseFile), now);

  const profile = pool.find((candidate) => !state.leases[candidate]);
  if (!profile) {
    writeLeaseState(state, leaseFile);
    return {
      error: "pool_exhausted",
      target,
      pool,
      active_leases: pool
        .map((candidate) => state.leases[candidate])
        .filter((lease): lease is BrowserProfileLease => Boolean(lease)),
      ttl_seconds: ttlSeconds,
      lease_file: leaseFile,
    };
  }

  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const lease: BrowserProfileLease = {
    profile,
    target,
    caller_label: callerLabel,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
  };
  const nextState: BrowserProfileLeaseState = {
    leases: { ...state.leases, [profile]: lease },
  };
  writeLeaseState(nextState, leaseFile);

  return {
    target,
    profile_name: profile,
    lease,
    ttl_seconds: ttlSeconds,
    lease_file: leaseFile,
  };
}
