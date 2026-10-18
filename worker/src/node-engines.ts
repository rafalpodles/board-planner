import { delimiter, join } from "node:path";

export interface GateNode {
  version: string;
  path: string;
}

type Version = [number, number, number];
type Bound = { op: ">=" | "<"; version: Version };

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// A partial like `26`, `26.1` or `26.x` is a range of its own, as in node-semver: up to the next
// value of the last part it names.
function partial(token: string): { lower: Version; upper: Version } | null {
  const parts = token.split(".");
  const numbers: number[] = [];
  for (const part of parts) {
    if (part === "x" || part === "X" || part === "*") break;
    if (!/^\d+$/.test(part)) return null;
    numbers.push(Number(part));
  }
  if (numbers.length === 0 || numbers.length > 3) return null;
  const pad = (values: number[]): Version => [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
  const upper = [...numbers];
  upper[upper.length - 1] += 1;
  return { lower: pad(numbers), upper: pad(upper) };
}

function bounds(token: string): Bound[] | null {
  if (token === "*" || token === "x" || token === "X" || token === "") return [];

  const operator = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
  const op = operator?.[1] ?? "";
  const rest = operator?.[2] ?? "";
  const named = partial(rest);
  if (!named) return null;
  const count = rest.split(".").filter((p) => /^\d+$/.test(p)).length;
  const exact = parseVersion(rest);

  switch (op) {
    case ">=": return [{ op: ">=", version: named.lower }];
    case ">": return [{ op: ">=", version: exact ?? named.upper }];
    case "<": return [{ op: "<", version: named.lower }];
    case "<=": return [{ op: "<", version: exact ? [exact[0], exact[1], exact[2] + 1] : named.upper }];
    case "": case "=": return [{ op: ">=", version: named.lower }, { op: "<", version: exact ? [exact[0], exact[1], exact[2] + 1] : named.upper }];
    case "~": return [{ op: ">=", version: named.lower }, { op: "<", version: count >= 2 ? [named.lower[0], named.lower[1] + 1, 0] : [named.lower[0] + 1, 0, 0] }];
    case "^": {
      const [major, minor, patch] = named.lower;
      const upper: Version = major > 0 || count === 1 ? [major + 1, 0, 0] : minor > 0 || count === 2 ? [0, minor + 1, 0] : [0, 0, patch + 1];
      return [{ op: ">=", version: named.lower }, { op: "<", version: upper }];
    }
    default: return null;
  }
}

/**
 * Whether `version` satisfies an `engines.node` range, or null for a range this cannot read. Covers
 * what package.json files use — `>=26`, `^22.12`, `~20.1.0`, `22.x`, `>=20 <23`, `a || b` — and
 * nothing else, rather than a dependency: the worker ships with none.
 */
export function satisfiesNodeRange(version: string, range: string): boolean | null {
  const actual = parseVersion(version);
  if (!actual) return null;

  let anyAlternative = false;
  for (const alternative of range.split("||")) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    let all = true;
    for (const token of tokens.length ? tokens : ["*"]) {
      const parsed = bounds(token);
      if (parsed === null) return null;
      for (const bound of parsed) {
        const order = compare(actual, bound.version);
        if (bound.op === ">=" ? order < 0 : order >= 0) all = false;
      }
    }
    if (all) anyAlternative = true;
  }
  return anyAlternative;
}

/** The first executable `name` on a PATH, the way a shell — and `/usr/bin/env node` — finds it. */
export function firstOnPath(
  name: string,
  pathValue: string,
  isExecutable: (path: string) => boolean
): string | null {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
