/**
 * BP-1081. Which e2e groups call each route file directly, measured from a CI run's request log
 * rather than kept by hand. `e2e/request-log.cjs` writes what the app server under test received,
 * `e2e/request-log-reporter.ts` writes when each test ran and in which group; with `workers: 1`
 * a request inside a test's window was made by that test. `scripts/route-groups.ts` turns one
 * run's logs into `e2e/route-groups.json`, which `computeAffectedGroups` adds to its own table.
 *
 * Only a spec's own calls count (`direct`): a page fetching a route on every load reaches it from
 * every group and pins it from none.
 */
import type { GroupName } from "./groups.ts";

export interface LoggedRequest {
  t: number;
  method: string;
  path: string;
  direct: boolean;
}

export interface TestWindow {
  start: number;
  end: number;
  group: string;
  spec: string;
}

export type RouteGroups = Record<string, readonly string[]>;

/**
 * One run's tests, each stretched to the start of the next and the last to the end of the run, so
 * an `afterAll` belongs to the test before it. With `workers: 1` nothing else runs in between.
 */
export function backToBack(tests: readonly TestWindow[], runEnd: number | undefined): TestWindow[] {
  const ordered = [...tests].sort((a, b) => a.start - b.start);
  return ordered.map((test, i) => ({
    ...test,
    end: ordered[i + 1]?.start ?? Math.max(test.end, runEnd ?? test.end),
  }));
}

// next.config.ts's rewrites, which the server applies after the request was logged under the
// path the spec asked for. route-groups.test.ts fails when the two lists disagree.
export const REWRITES: readonly { source: string; destination: string }[] = [
  {
    source: "/api/projects/:projectId/tasks/:taskId/checklist/:itemId",
    destination: "/api/task-leaf/checklist-item/:projectId/:taskId/:itemId",
  },
  {
    source: "/api/projects/:projectId/tasks/:taskId/comments/:commentId",
    destination: "/api/task-leaf/comment/:projectId/:taskId/:commentId",
  },
];

type Segment =
  | { kind: "static"; name: string }
  | { kind: "dynamic" }
  | { kind: "catch-all" }
  | { kind: "optional-catch-all" };

// The order Next prefers when more than one route could answer
const RANK: Record<Segment["kind"], number> = { static: 0, dynamic: 1, "catch-all": 2, "optional-catch-all": 3 };

interface Route {
  file: string;
  segments: Segment[];
}

function segmentsOf(file: string): Segment[] {
  return file
    .replace(/^src\/app\//, "")
    .replace(/\/?route\.[jt]s$/, "")
    .split("/")
    .filter((part) => part && !/^\(.*\)$/.test(part))
    .map((part): Segment => {
      if (/^\[\[\.\.\..+\]\]$/.test(part)) return { kind: "optional-catch-all" };
      if (/^\[\.\.\..+\]$/.test(part)) return { kind: "catch-all" };
      if (/^\[.+\]$/.test(part)) return { kind: "dynamic" };
      return { kind: "static", name: part };
    });
}

function matches(segments: readonly Segment[], parts: readonly string[]): boolean {
  const [first, ...rest] = segments;
  if (!first) return parts.length === 0;
  if (first.kind === "catch-all") return parts.length > 0 && rest.length === 0;
  if (first.kind === "optional-catch-all") return rest.length === 0;
  if (parts.length === 0) return false;
  if (first.kind === "static" && first.name !== parts[0]) return false;
  return matches(rest, parts.slice(1));
}

function moreSpecific(a: Route, b: Route): number {
  for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
    const left = a.segments[i] ? RANK[a.segments[i].kind] : -1;
    const right = b.segments[i] ? RANK[b.segments[i].kind] : -1;
    if (left !== right) return left - right;
  }
  return 0;
}

function rewritten(path: string): string {
  for (const { source, destination } of REWRITES) {
    const pattern = new RegExp(`^${source.replace(/:[A-Za-z]+/g, "([^/]+)")}$`);
    const found = path.match(pattern);
    if (!found) continue;
    const names = [...source.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
    return names.reduce((to, name, i) => to.replace(`:${name}`, found[i + 1]), destination);
  }
  return path;
}

/** Resolves a request path to the route file that answers it, the way Next picks between candidates. */
export function routeResolver(routeFiles: readonly string[]): (path: string) => string | null {
  const routes: Route[] = routeFiles.map((file) => ({ file, segments: segmentsOf(file) }));
  return (path) => {
    const parts = rewritten(path.split("?")[0]).split("/").filter(Boolean);
    const candidates = routes.filter((route) => matches(route.segments, parts)).sort(moreSpecific);
    return candidates[0]?.file ?? null;
  };
}

function windowAt(windows: readonly TestWindow[], t: number): TestWindow | undefined {
  let low = 0;
  let high = windows.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (windows[mid].end < t) low = mid + 1;
    else if (windows[mid].start > t) high = mid - 1;
    else return windows[mid];
  }
  return undefined;
}

export interface Caller {
  group: string;
  spec: string;
}

/**
 * Who called each route file directly, from one CI job's logs. Logs from different jobs overlap in
 * time and must be measured apart. A request outside every test (global setup's warm-up, the
 * teardown) belongs to no group and is left out.
 */
export function measureCallers(
  requests: readonly LoggedRequest[],
  tests: readonly TestWindow[],
  routeFor: (path: string) => string | null
): Map<string, Caller[]> {
  const windows = [...tests].sort((a, b) => a.start - b.start);
  const callers = new Map<string, Caller[]>();
  for (const request of requests) {
    if (!request.direct) continue;
    const test = windowAt(windows, request.t);
    if (!test) continue;
    const file = routeFor(request.path);
    if (!file) continue;
    const known = callers.get(file) ?? [];
    if (!known.some((c) => c.group === test.group && c.spec === test.spec)) {
      known.push({ group: test.group, spec: test.spec });
    }
    callers.set(file, known);
  }
  return callers;
}

export function groupsOf(callers: ReadonlyMap<string, readonly Caller[]>, order: readonly string[]): RouteGroups {
  const map: Record<string, string[]> = {};
  for (const file of [...callers.keys()].sort()) {
    const groups = new Set(callers.get(file)!.map((c) => c.group));
    map[file] = order.filter((g) => groups.has(g));
  }
  return map;
}

export interface Unplanned {
  file: string;
  group: string;
  specs: string[];
}

/** Each measured caller whose group a change to that route file would not run. */
export function unplannedCallers(
  callers: ReadonlyMap<string, readonly Caller[]>,
  plan: (file: string) => readonly GroupName[]
): Unplanned[] {
  const missing: Unplanned[] = [];
  for (const file of [...callers.keys()].sort()) {
    const planned = new Set<string>(plan(file));
    const byGroup = new Map<string, string[]>();
    for (const { group, spec } of callers.get(file)!) {
      if (planned.has(group)) continue;
      byGroup.set(group, [...(byGroup.get(group) ?? []), spec]);
    }
    for (const [group, specs] of byGroup) missing.push({ file, group, specs: specs.sort() });
  }
  return missing;
}
