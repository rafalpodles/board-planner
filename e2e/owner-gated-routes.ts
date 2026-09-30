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

/**
 * BP-748. Owner-only behaviour written inline rather than through the wrapper: every
 * `check(…, "admin")` and every `administeredProjectIds(…)` in a route file, attributed to the
 * exported method that runs it, directly or through one module-level helper.
 */
export type InlineOwnerCheck = OwnerGatedRoute & { line: number };

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DECLARATION = /^(export\s+)?(?:const|let|var|class|interface|type|enum|(?:async\s+)?function\*?)\s+(\w+)/gm;
const CHECK_CALL = /(?<![.\w$])check\s*\(/g;
const BATCHED_CALL = /(?<![.\w$])administeredProjectIds\s*\(/g;
const ALIASED_GRANT = /\b(?:check|administeredProjectIds)\s+as\s+\w+/g;

/** The source with every comment blanked to spaces, so offsets and line numbers still hold. */
export function withoutComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templateClosesAt: number[] = [];
  let depth = 0;

  const skipTemplate = (from: number): number => {
    let k = from;
    while (k < source.length) {
      if (source[k] === "\\") k += 2;
      else if (source[k] === "`") return k + 1;
      else if (source[k] === "$" && source[k + 1] === "{") {
        templateClosesAt.push(depth++);
        return k + 2;
      } else k++;
    }
    return k;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      i = k + 1;
    } else if (c === "`") {
      i = skipTemplate(i + 1);
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i = templateClosesAt.at(-1) === depth ? (templateClosesAt.pop(), skipTemplate(i + 1)) : i + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lastArgument(source: string, open: number): string | null {
  let depth = 0;
  let lastComma = open;
  for (let k = open; k < source.length; k++) {
    const c = source[k];
    if (c === '"' || c === "'" || c === "`") {
      k++;
      while (k < source.length && source[k] !== c) k += source[k] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return source.slice(lastComma + 1, k).trim().replace(/,$/, "").trim();
    } else if (c === "," && depth === 1) {
      if (source.slice(k + 1).trimStart()[0] !== ")") lastComma = k;
    }
  }
  return null;
}

const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

export function inlineOwnerChecks(raw: string): { sites: { method: string; line: number }[]; unread: string[] } {
  const source = withoutComments(raw);
  const unread = [...source.matchAll(ALIASED_GRANT)].map(
    (m) => `line ${lineOf(source, m.index)}: ${m[0]} hides a grant check under another name`
  );

  const found: number[] = [...source.matchAll(BATCHED_CALL)].map((m) => m.index);
  for (const m of source.matchAll(CHECK_CALL)) {
    const need = lastArgument(source, m.index + m[0].length - 1);
    if (need === '"admin"' || need === "'admin'") found.push(m.index);
    else if (need !== '"access"' && need !== "'access'") {
      unread.push(`line ${lineOf(source, m.index)}: check() with a need this scan cannot read (${need})`);
    }
  }

  const declarations = [...source.matchAll(DECLARATION)].map((m, n, all) => ({
    exported: !!m[1],
    name: m[2],
    body: source.slice(m.index, all[n + 1]?.index ?? source.length),
    start: m.index,
  }));
  const methods = declarations.filter((d) => d.exported && HTTP_METHODS.has(d.name));

  const sites: { method: string; line: number }[] = [];
  for (const offset of found.sort((a, b) => a - b)) {
    const line = lineOf(source, offset);
    const enclosing = declarations.filter((d) => d.start < offset).at(-1);
    if (!enclosing) {
      unread.push(`line ${line}: an owner check outside any declaration`);
    } else if (methods.includes(enclosing)) {
      sites.push({ method: enclosing.name, line });
    } else {
      const callsIt = new RegExp(`(?<![.\\w$])${enclosing.name}\\s*\\(`);
      const callers = methods.filter((m) => callsIt.test(m.body));
      if (callers.length === 0) {
        unread.push(`line ${line}: an owner check in ${enclosing.name}, which no exported method calls directly`);
      }
      for (const caller of callers) sites.push({ method: caller.name, line });
    }
  }
  return { sites, unread };
}

export function scanInlineOwnerChecks(root = API_ROOT): InlineOwnerCheck[] {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (f) => f === "route.ts" || f.endsWith(`${sep}route.ts`)
  );

  const checks: InlineOwnerCheck[] = [];
  for (const file of files) {
    const { sites, unread } = inlineOwnerChecks(readFileSync(join(root, file), "utf8"));
    if (unread.length > 0) {
      throw new Error(`${file} has an owner check this scan does not read — ${unread.join("; ")}`);
    }
    const path = `/api/${dirname(file).split(sep).join("/")}`;
    const seen = new Map<string, number>();
    for (const { method, line } of sites) {
      const base = `${method} ${path}`;
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      checks.push({ method, path, line, key: nth === 1 ? base : `${base} #${nth}` });
    }
  }
  return checks.sort((a, b) => a.key.localeCompare(b.key));
}
