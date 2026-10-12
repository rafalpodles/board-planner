import pkg from "../../package.json";

const SHA_VARIABLES = ["GIT_SHA", "RAILWAY_GIT_COMMIT_SHA", "SOURCE_VERSION"] as const;
const SHA_SHAPE = /^[0-9a-f]{7,64}$/i;
const SHORT_LENGTH = 7;
const UNKNOWN = "unknown";

const startedAt = new Date().toISOString();

export interface BuildInfo {
  version: string;
  sha: string;
  shortSha: string;
  startedAt: string;
}

export function resolveSha(env: Record<string, string | undefined> = process.env): string {
  for (const name of SHA_VARIABLES) {
    const value = env[name]?.trim();
    if (value && SHA_SHAPE.test(value)) return value.toLowerCase();
  }
  return UNKNOWN;
}

export function getBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const sha = resolveSha(env);
  return {
    version: pkg.version,
    sha,
    shortSha: sha === UNKNOWN ? UNKNOWN : sha.slice(0, SHORT_LENGTH),
    startedAt,
  };
}
