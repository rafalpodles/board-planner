import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * Every route + method gated on `withProjectOwner`, read from the route files themselves (BP-699),
 * so the spec that drives them cannot fall behind a new one. Plain fs/path only: the vitest guard
 * imports this as well as the Playwright spec.
 */
export const API_ROOT = join(__dirname, "..", "src", "app", "api");

export type OwnerGatedRoute = { method: string; path: string; key: string };

const GATED_EXPORT = /^export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*withProjectOwner\(/gm;
const ANY_CALL = /\bwithProjectOwner\(/g;
const ALIASED = /\bwithProjectOwner\s+as\s+\w+/g;

export function ownerGatedMethods(source: string): { methods: string[]; unread: number } {
  const methods = [...source.matchAll(GATED_EXPORT)].map((m) => m[1]);
  const aliases = (source.match(ALIASED) ?? []).length;
  return { methods, unread: (source.match(ANY_CALL) ?? []).length - methods.length + aliases };
}

export function scanOwnerGatedRoutes(root = API_ROOT): OwnerGatedRoute[] {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (f) => f === "route.ts" || f.endsWith(`${sep}route.ts`)
  );

  const routes: OwnerGatedRoute[] = [];
  for (const file of files) {
    const { methods, unread } = ownerGatedMethods(readFileSync(join(root, file), "utf8"));
    if (unread !== 0) {
      throw new Error(
        `${file} calls withProjectOwner in a shape this scan does not read — teach GATED_EXPORT it`
      );
    }
    const path = `/api/${dirname(file).split(sep).join("/")}`;
    for (const method of methods) routes.push({ method, path, key: `${method} ${path}` });
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
