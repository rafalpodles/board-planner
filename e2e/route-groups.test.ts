import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { GROUP_NAMES, type GroupName } from "./groups.ts";
import { computeAffectedGroups } from "./affected-groups.ts";
import MEASURED from "./route-groups.json" with { type: "json" };
import RequestLogReporter from "./request-log-reporter.ts";
import {
  REWRITES,
  backToBack,
  groupsOf,
  lostLog,
  measureCallers,
  routeResolver,
  unplannedCallers,
  type Caller,
  type LoggedRequest,
  type TestWindow,
} from "./route-groups.ts";

const ROOT = join(__dirname, "..");
const ROUTE_FILES = (readdirSync(join(ROOT, "src", "app"), { recursive: true }) as string[])
  .filter((file) => /(^|\/)route\.[jt]s$/.test(file))
  .map((file) => `src/app/${file}`);
const routeFor = routeResolver(ROUTE_FILES);

describe("routeResolver", () => {
  it("prefers a static segment to a dynamic one, as Next does", () => {
    expect(routeFor("/api/projects/p1/tasks/claim")).toBe("src/app/api/projects/[projectId]/tasks/claim/route.ts");
    expect(routeFor("/api/projects/p1/tasks/claim?after=t1")).toBe("src/app/api/projects/[projectId]/tasks/claim/route.ts");
    expect(routeFor("/api/projects/p1/tasks/t1")).toBe("src/app/api/projects/[projectId]/tasks/[taskId]/route.ts");
    expect(routeFor("/api/projects/p1/tasks/t1/status")).toBe(
      "src/app/api/projects/[projectId]/tasks/[taskId]/status/route.ts"
    );
  });

  it("follows next.config's rewrites to the route that answers", () => {
    expect(routeFor("/api/projects/p1/tasks/t1/comments/c1")).toBe("src/app/api/task-leaf/comment/[...ids]/route.ts");
    expect(routeFor("/api/projects/p1/tasks/t1/checklist/i1")).toBe(
      "src/app/api/task-leaf/checklist-item/[...ids]/route.ts"
    );
  });

  it("resolves the routes outside /api, and nothing for a page or an unknown path", () => {
    expect(routeFor("/oauth/token")).toBe("src/app/oauth/token/route.ts");
    expect(routeFor("/.well-known/oauth-protected-resource")).toBe(
      "src/app/.well-known/oauth-protected-resource/route.ts"
    );
    expect(routeFor("/projects/p1")).toBeNull();
    expect(routeFor("/api/no-such-route/anywhere")).toBeNull();
  });

  it("drops a query and skips route groups in a file's path", () => {
    const resolve = routeResolver(["src/app/(group)/api/a/[id]/route.ts", "src/app/api/a/[...rest]/route.ts"]);
    expect(resolve("/api/a/1?x=2")).toBe("src/app/(group)/api/a/[id]/route.ts");
    expect(resolve("/api/a/1/2")).toBe("src/app/api/a/[...rest]/route.ts");
    expect(resolve("/api/a")).toBeNull();
  });

  it("lets an optional catch-all answer its bare path too", () => {
    const resolve = routeResolver(["src/app/api/b/[[...rest]]/route.ts"]);
    expect(resolve("/api/b")).toBe("src/app/api/b/[[...rest]]/route.ts");
    expect(resolve("/api/b/c/d")).toBe("src/app/api/b/[[...rest]]/route.ts");
  });

  it("knows the same rewrites next.config.ts makes", async () => {
    expect(await nextConfig.rewrites!()).toEqual(REWRITES);
  });
});

const tests: TestWindow[] = [
  { start: 100, end: 200, group: "automation", spec: "claim-ownership.spec.ts" },
  { start: 300, end: 400, group: "automation", spec: "worker-controls.spec.ts" },
];
const call = (t: number, path: string, direct = true): LoggedRequest => ({ t, method: "POST", path, direct });

describe("backToBack", () => {
  it("stretches each test to the next one's start and the last to the end of its run", () => {
    const run = [
      { start: 300, end: 350, group: "people", spec: "b.spec.ts" },
      { start: 100, end: 150, group: "people", spec: "a.spec.ts" },
    ];
    expect(backToBack(run, 900).map(({ start, end }) => [start, end])).toEqual([
      [100, 300],
      [300, 900],
    ]);
  });

  it("ends a test the runner heard of after the next one started where that one starts", () => {
    const run = [
      { start: 100, end: 320, group: "people", spec: "a.spec.ts" },
      { start: 300, end: 400, group: "people", spec: "b.spec.ts" },
    ];
    expect(backToBack(run, undefined).map(({ start, end }) => [start, end])).toEqual([
      [100, 300],
      [300, 400],
    ]);
  });

  it("keeps a run's last test as it was when the run's end was not written", () => {
    expect(backToBack([{ start: 1, end: 5, group: "people", spec: "a.spec.ts" }], undefined)[0].end).toBe(5);
  });
});

describe("measureCallers", () => {
  it("names the group and spec of the test running when a spec called a route", () => {
    const callers = measureCallers(
      [call(100, "/api/projects/p/tasks/claim"), call(400, "/api/projects/p/tasks/claim"), call(350, "/api/projects/p/tasks/t")],
      tests,
      routeFor
    );
    expect(callers.get("src/app/api/projects/[projectId]/tasks/claim/route.ts")).toEqual([
      { group: "automation", spec: "claim-ownership.spec.ts" },
      { group: "automation", spec: "worker-controls.spec.ts" },
    ]);
    expect(callers.get("src/app/api/projects/[projectId]/tasks/[taskId]/route.ts")).toEqual([
      { group: "automation", spec: "worker-controls.spec.ts" },
    ]);
  });

  it("leaves out what a page fetched, what no test made, and paths no route answers", () => {
    const callers = measureCallers(
      [
        call(150, "/api/projects/p/tasks/claim", false),
        call(50, "/api/projects/p/tasks/t"),
        call(250, "/api/projects/p/tasks/t"),
        call(450, "/api/projects/p/tasks/t"),
        call(150, "/projects/p"),
      ],
      tests,
      routeFor
    );
    expect(callers.size).toBe(0);
  });

  it("orders each file's groups canonically", () => {
    const callers = new Map<string, Caller[]>([
      ["src/x/route.ts", [{ group: "automation", spec: "a.spec.ts" }, { group: "tasks", spec: "b.spec.ts" }]],
    ]);
    expect(groupsOf(callers, GROUP_NAMES)).toEqual({ "src/x/route.ts": ["tasks", "automation"] });
  });
});

describe("unplannedCallers", () => {
  const claim = "src/app/api/projects/[projectId]/tasks/claim/route.ts";
  const callers = new Map<string, Caller[]>([
    [
      claim,
      [
        { group: "tasks", spec: "a.spec.ts" },
        { group: "automation", spec: "claim-ownership.spec.ts" },
        { group: "automation", spec: "worker-controls.spec.ts" },
      ],
    ],
  ]);

  it("names a spec that calls a route from a group a change to it would not run", () => {
    expect(unplannedCallers(callers, () => ["tasks"])).toEqual([
      { file: claim, group: "automation", specs: ["claim-ownership.spec.ts", "worker-controls.spec.ts"] },
    ]);
  });

  it("finds nothing once the plan includes every calling group", () => {
    expect(unplannedCallers(callers, () => ["tasks", "automation"])).toEqual([]);
  });
});

describe("e2e/route-groups.json", () => {
  const map = MEASURED as Record<string, GroupName[]>;

  it("names only route files that exist, and only groups that exist", () => {
    for (const [file, groups] of Object.entries(map)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(GROUP_NAMES.filter((g) => groups.includes(g)), file).toEqual(groups);
    }
  });

  it("is in every plan for the route it was measured on", () => {
    for (const [file, groups] of Object.entries(map)) {
      expect(computeAffectedGroups([file]), file).toEqual(expect.arrayContaining(groups));
    }
  });

  it("runs automation for the claim route, whose directory says tasks, and people for admin sign-up", () => {
    expect(computeAffectedGroups(["src/app/api/projects/[projectId]/tasks/claim/route.ts"])).toEqual(
      expect.arrayContaining(["tasks", "automation"])
    );
    expect(computeAffectedGroups(["src/app/api/admin/sign-up/route.ts"])).toEqual(expect.arrayContaining(["people"]));
  });
});

describe("lostLog", () => {
  it("refuses a job whose requests have no test to belong to, or whose tests have no call", () => {
    expect(lostLog(40, 0, 0)).toMatch(/40 requests and no test/);
    expect(lostLog(40, 12, 0)).toMatch(/12 tests and logged no direct call/);
  });

  it("accepts a job that measured something, and one that ran nothing", () => {
    expect(lostLog(40, 12, 3)).toBeNull();
    expect(lostLog(0, 0, 0)).toBeNull();
  });
});

function unmarkedPageFetches(source: string): number {
  let found = 0;
  const file = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node, inPage: boolean): void => {
    if (inPage && ts.isCallExpression(node) && node.expression.getText() === "fetch") {
      if (!node.arguments[1]?.getText().includes('"x-e2e-direct"')) found++;
    }
    const evaluates =
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "evaluate";
    ts.forEachChild(node, (child) => visit(child, inPage || evaluates));
  };
  visit(file, false);
  return found;
}

describe("a spec's fetch inside the page", () => {
  it("counts one with no marker, not one with it, nor Node's own, nor one named in a comment", () => {
    expect(unmarkedPageFetches('page.evaluate(() => fetch("/api/a"));')).toBe(1);
    expect(unmarkedPageFetches('page.evaluate(() => fetch("/api/a", { headers: { "x-e2e-direct": "1" } }));')).toBe(0);
    expect(unmarkedPageFetches('await fetch("/api/a"); route.fetch();')).toBe(0);
    expect(unmarkedPageFetches('page.evaluate(() => { /* fetch("/api/a") */ });')).toBe(0);
  });

  it("carries x-e2e-direct in every spec, so the route it calls is measured", () => {
    const sources = (readdirSync(join(ROOT, "e2e"), { recursive: true }) as string[]).filter(
      (file) => /\.ts$/.test(file) && !file.endsWith(".test.ts") && file !== "request-log.spec.ts"
    );
    expect(sources.length).toBeGreaterThan(100);
    const unmarked = sources.filter((file) => unmarkedPageFetches(readFileSync(join(ROOT, "e2e", file), "utf8")) > 0);
    expect(unmarked).toEqual([]);
  });
});

describe("RequestLogReporter", () => {
  afterEach(() => vi.useRealTimers());

  it("writes each test from when the worker started it to when the runner heard it end, then the run's end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const dir = mkdtempSync(join(tmpdir(), "request-log-"));
    const reporter = new RequestLogReporter({ dir });
    const test = {
      parent: { project: () => ({ name: "automation" }) },
      location: { file: "/repo/e2e/claim-ownership.spec.ts" },
    };
    reporter.onTestEnd(test as never, { startTime: new Date(1000), duration: 250 } as never);
    vi.setSystemTime(6000);
    reporter.onEnd();

    const [file] = readdirSync(dir);
    expect(file).toMatch(/^tests-.*\.ndjson$/);
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { start: 1000, end: 5000, group: "automation", spec: "claim-ownership.spec.ts" },
      { runEnd: 6000 },
    ]);
  });

  it("writes nothing without a directory", () => {
    const reporter = new RequestLogReporter({ dir: "" });
    expect(() => reporter.onTestEnd({} as never, {} as never)).not.toThrow();
    expect(() => reporter.onEnd()).not.toThrow();
  });
});
