import "./env.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// License file lives at repo root /data/license.json, next to .env for easy editing.
const LICENSE_FILE_PATH = resolve(__dirname, "../../../data/license.json");
const LICENSE_CACHE_TTL_MS = 30_000;

export type StoredLicense = {
  mode: "open" | "licensed";
  plan: "FREE" | "PRO" | "ELITE";
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE";
  maxScanTokensOverride: number | null;
  maxActiveTradesOverride: number | null;
  note: string | null;
  updatedAt: string;
};

const DEFAULT_LICENSE: StoredLicense = {
  mode: "open",
  plan: "PRO",
  status: "ACTIVE",
  maxScanTokensOverride: null,
  maxActiveTradesOverride: null,
  note: null,
  updatedAt: new Date().toISOString()
};

let cachedLicense: StoredLicense | null = null;
let licenseLoadedAt = 0;

function ensureDataDir(): void {
  const dir = dirname(LICENSE_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function parseStoredLicense(raw: unknown): StoredLicense {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_LICENSE };
  }

  const r = raw as Record<string, unknown>;

  return {
    mode: r["mode"] === "licensed" ? "licensed" : "open",
    plan:
      r["plan"] === "FREE" ? "FREE"
      : r["plan"] === "ELITE" ? "ELITE"
      : "PRO",
    status:
      r["status"] === "TRIALING" ? "TRIALING"
      : r["status"] === "PAST_DUE" ? "PAST_DUE"
      : r["status"] === "INACTIVE" ? "INACTIVE"
      : "ACTIVE",
    maxScanTokensOverride:
      typeof r["maxScanTokensOverride"] === "number" && Number.isFinite(r["maxScanTokensOverride"])
        ? Math.max(1, Math.trunc(r["maxScanTokensOverride"]))
        : null,
    maxActiveTradesOverride:
      typeof r["maxActiveTradesOverride"] === "number" && Number.isFinite(r["maxActiveTradesOverride"])
        ? Math.max(0, Math.trunc(r["maxActiveTradesOverride"]))
        : null,
    note: typeof r["note"] === "string" ? r["note"] : null,
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : new Date().toISOString()
  };
}

export function loadLicenseSync(): StoredLicense {
  const now = Date.now();
  if (cachedLicense && now - licenseLoadedAt < LICENSE_CACHE_TTL_MS) {
    return cachedLicense;
  }

  if (!existsSync(LICENSE_FILE_PATH)) {
    cachedLicense = { ...DEFAULT_LICENSE };
    licenseLoadedAt = now;
    return cachedLicense;
  }

  try {
    const raw = JSON.parse(readFileSync(LICENSE_FILE_PATH, "utf-8")) as unknown;
    cachedLicense = parseStoredLicense(raw);
    licenseLoadedAt = now;
    return cachedLicense;
  } catch (error) {
    console.error("[license-store] Failed to parse license.json, using defaults", {
      path: LICENSE_FILE_PATH,
      error: error instanceof Error ? error.message : String(error)
    });
    cachedLicense = { ...DEFAULT_LICENSE };
    licenseLoadedAt = now;
    return cachedLicense;
  }
}

export function saveLicense(update: Partial<Omit<StoredLicense, "updatedAt">>): StoredLicense {
  const current = loadLicenseSync();
  const next: StoredLicense = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString()
  };

  ensureDataDir();
  writeFileSync(LICENSE_FILE_PATH, JSON.stringify(next, null, 2), "utf-8");
  cachedLicense = next;
  licenseLoadedAt = Date.now();

  console.info("[license-store] License saved", {
    plan: next.plan,
    status: next.status,
    mode: next.mode
  });

  return next;
}

export function invalidateLicenseCache(): void {
  cachedLicense = null;
  licenseLoadedAt = 0;
}

export function getLicenseFilePath(): string {
  return LICENSE_FILE_PATH;
}
