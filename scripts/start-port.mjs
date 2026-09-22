import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

// The files `next start` reads, highest precedence first. It reads them only once the port is
// already bound, which is why a PORT in .env never moved it (BP-775).
const ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

export const DEFAULT_PORT = "3000";

/**
 * @param {string} dir
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function startPort(dir, env) {
  const fromEnvironment = env.PORT?.trim();
  if (fromEnvironment) return fromEnvironment;
  for (const name of ENV_FILES) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const port = parseEnv(text).PORT?.trim();
    if (port) return port;
  }
  return DEFAULT_PORT;
}
