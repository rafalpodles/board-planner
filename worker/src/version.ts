import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const UNKNOWN_VERSION = "0.0.0-unknown";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// The app bundle puts package.json beside main.js; the tarball and a clone keep it one level up,
// next to dist/.
export function workerVersion(read: (path: string) => string | null, entryDir: string): string {
  for (const candidate of [join(entryDir, "package.json"), join(entryDir, "..", "package.json")]) {
    let raw: string | null;
    try {
      raw = read(candidate);
    } catch {
      continue;
    }
    if (raw === null) continue;
    try {
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === "string" && SEMVER.test(version.trim())) return version.trim();
    } catch {
      continue;
    }
  }
  return UNKNOWN_VERSION;
}

export function entryDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}
