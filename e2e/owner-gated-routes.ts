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
 * exported method that runs it, directly or through one module-level helper. Anything it cannot
 * attribute that way is refused rather than skipped.
 */
export type InlineOwnerCheck = OwnerGatedRoute & { line: number };

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DECLARATION = /^(export\s+)?(?:const|let|var|class|interface|type|enum|(?:async\s+)?function\*?)\s+(\w+)/gm;
const CHECK_CALL = /(?<![.\w$])check\s*\(/g;
const BATCHED_CALL = /(?<![.\w$])administeredProjectIds\s*\(/g;
const ALIASED_GRANT = /\b(?:check|administeredProjectIds)\s+as\s+\w+/g;
const GRANT_NAME = /(?<![\w$])(?:check|administeredProjectIds)(?![\w$])/g;
const GRANTS_MODULE = /(["'])[^"'\n]*\blib\/grants(?:\.[jt]s)?\1/g;
const NAMED_IMPORT = /\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*(["'][^"'\n]*["'])/g;
const WORDS_BEFORE_A_REGEX = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await",
]);

function blankComments(source: string, blankLiterals: boolean): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const literal = (from: number, to: number) => {
    if (blankLiterals) blank(from, to);
  };
  const templateClosesAt: number[] = [];
  let depth = 0;
  let afterValue = false;

  const skipTemplate = (from: number): number => {
    let k = from;
    while (k < source.length) {
      if (source[k] === "\\") k += 2;
      else if (source[k] === "`") {
        literal(from, k);
        afterValue = true;
        return k + 1;
      } else if (source[k] === "$" && source[k + 1] === "{") {
        literal(from, k);
        templateClosesAt.push(depth++);
        afterValue = false;
        return k + 2;
      } else k++;
    }
    return k;
  };

  const endOfRegex = (from: number): number | null => {
    let inClass = false;
    for (let k = from + 1; k < source.length; k++) {
      const c = source[k];
      if (c === "\n") return null;
      if (c === "\\") k++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        let end = k + 1;
        while (/[a-z]/.test(source[end] ?? "")) end++;
        return end;
      }
    }
    return null;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const regexEnd = c === "/" && !afterValue ? endOfRegex(i) : null;
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
    } else if (regexEnd !== null) {
      literal(i + 1, regexEnd);
      afterValue = true;
      i = regexEnd;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      literal(i + 1, k);
      afterValue = true;
      i = k + 1;
    } else if (c === "`") {
      i = skipTemplate(i + 1);
    } else if (/[\w$]/.test(c)) {
      let k = i;
      while (k < source.length && /[\w$]/.test(source[k])) k++;
      afterValue = !WORDS_BEFORE_A_REGEX.has(source.slice(i, k));
      i = k;
    } else if (c === "}" && templateClosesAt.at(-1) === depth - 1) {
      templateClosesAt.pop();
      depth--;
      i = skipTemplate(i + 1);
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (!/\s/.test(c)) afterValue = c === ")" || c === "]" || c === "}";
      i++;
    }
  }
  return out.join("");
}

/** The source with every comment blanked to spaces, so offsets and line numbers still hold. */
export const withoutComments = (source: string) => blankComments(source, false);

/** withoutComments, with the insides of strings, templates and regular expressions blanked too. */
export const codeOnly = (source: string) => blankComments(source, true);

// Deliberately dumb, so a literal the real reader misjudges cannot hide a check from both
function naiveCommentMask(source: string): boolean[] {
  const mask = new Array<boolean>(source.length).fill(false);
  const opensAt = (k: number) => k === 0 || /[\s;,(){}]/.test(source[k - 1]);
  let inBlock = false;
  for (let k = 0; k < source.length; k++) {
    if (inBlock) {
      mask[k] = true;
      if (source[k] === "*" && source[k + 1] === "/") {
        mask[k + 1] = true;
        k++;
        inBlock = false;
      }
    } else if (source[k] === "/" && source[k + 1] === "/" && opensAt(k)) {
      while (k < source.length && source[k] !== "\n") mask[k++] = true;
    } else if (source[k] === "/" && source[k + 1] === "*" && opensAt(k)) {
      mask[k] = true;
      inBlock = true;
    }
  }
  return mask;
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

const isAdminNeed = (need: string | null) => need === '"admin"' || need === "'admin'";
const isAccessNeed = (need: string | null) => need === '"access"' || need === "'access'";

function ownerCheckOffsets(source: string): number[] {
  const offsets = [...source.matchAll(BATCHED_CALL)].map((m) => m.index);
  for (const m of source.matchAll(CHECK_CALL)) {
    if (isAdminNeed(lastArgument(source, m.index + m[0].length - 1))) offsets.push(m.index);
  }
  return offsets;
}

function grantsModuleUnread(source: string, code: string): string[] {
  const unread: string[] = [];
  const named = new Map<number, number>();
  for (const m of source.matchAll(NAMED_IMPORT)) {
    named.set(m.index + m[0].length - m[1].length, m.index);
  }
  const importSpans: [number, number][] = [];
  for (const m of source.matchAll(GRANTS_MODULE)) {
    const importStart = named.get(m.index);
    if (importStart === undefined) {
      const statement = source.slice(source.lastIndexOf("\n", m.index) + 1, m.index + m[0].length).trim();
      unread.push(`line ${lineOf(source, m.index)}: reaches the grants module as \`${statement}\`, which this scan does not follow`);
    } else {
      importSpans.push([importStart, m.index]);
    }
  }
  if (importSpans.length === 0) return unread;

  for (const m of code.matchAll(GRANT_NAME)) {
    if (importSpans.some(([from, to]) => m.index > from && m.index < to)) continue;
    if (code[m.index - 1] === ".") continue;
    if (/^\s*\(/.test(code.slice(m.index + m[0].length))) continue;
    unread.push(`line ${lineOf(source, m.index)}: ${m[0]} used other than as a direct call`);
  }
  return unread;
}

export function inlineOwnerChecks(raw: string): { sites: { method: string; line: number }[]; unread: string[] } {
  const source = withoutComments(raw);
  const code = codeOnly(raw);
  const unread = [...source.matchAll(ALIASED_GRANT)].map(
    (m) => `line ${lineOf(source, m.index)}: ${m[0]} hides a grant check under another name`
  );
  unread.push(...grantsModuleUnread(source, code));

  for (const m of source.matchAll(CHECK_CALL)) {
    const need = lastArgument(source, m.index + m[0].length - 1);
    if (!isAdminNeed(need) && !isAccessNeed(need)) {
      unread.push(`line ${lineOf(source, m.index)}: check() with a need this scan cannot read (${need})`);
    }
  }

  const naive = naiveCommentMask(raw);
  for (const offset of ownerCheckOffsets(raw)) {
    if (source[offset] === " " && !naive[offset]) {
      unread.push(`line ${lineOf(raw, offset)}: an owner check the comment reader blanked, though it is not in a comment`);
    }
  }

  const declarations = [...code.matchAll(DECLARATION)].map((m, n, all) => ({
    exported: !!m[1],
    name: m[2],
    start: m.index,
    end: all[n + 1]?.index ?? code.length,
  }));
  const methods = declarations.filter((d) => d.exported && HTTP_METHODS.has(d.name));
  const methodAt = (offset: number) => methods.find((m) => m.start <= offset && offset < m.end);

  const sites: { method: string; line: number }[] = [];
  for (const offset of ownerCheckOffsets(source).sort((a, b) => a - b)) {
    const line = lineOf(source, offset);
    const enclosing = declarations.filter((d) => d.start < offset).at(-1);
    if (!enclosing) {
      unread.push(`line ${line}: an owner check outside any declaration`);
      continue;
    }
    if (methods.includes(enclosing)) {
      sites.push({ method: enclosing.name, line });
      continue;
    }
    if (enclosing.exported) {
      unread.push(`line ${line}: an owner check in ${enclosing.name}, which the file exports`);
      continue;
    }

    const callers = new Set<string>();
    const reference = new RegExp(`(?<![\\w$])${enclosing.name}(?![\\w$])`, "g");
    for (const m of code.matchAll(reference)) {
      if (m.index >= enclosing.start && m.index < enclosing.end) continue;
      const caller = methodAt(m.index);
      const direct = code[m.index - 1] !== "." && /^\s*\(/.test(code.slice(m.index + m[0].length));
      if (caller && direct) callers.add(caller.name);
      else {
        unread.push(
          `line ${lineOf(source, m.index)}: ${enclosing.name}, which holds the owner check at line ${line}, ` +
            `is used other than as a direct call from an exported method`
        );
      }
    }
    if (callers.size === 0) {
      unread.push(`line ${line}: an owner check in ${enclosing.name}, which no exported method calls directly`);
    }
    for (const method of methods) if (callers.has(method.name)) sites.push({ method: method.name, line });
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
