import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { GROUP_NAMES, type GroupName } from "./groups.ts";
import { computeAffectedGroups } from "./affected-groups.ts";
import MEASURED from "./route-groups.json" with { type: "json" };
import RequestLogReporter from "./request-log-reporter.ts";
import {
  REWRITES,
  groupsOf,
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
});

describe("RequestLogReporter", () => {
  it("writes each test's window from the worker's own clock, with its group and spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "request-log-"));
    const reporter = new RequestLogReporter({ dir });
    const test = {
      parent: { project: () => ({ name: "automation" }) },
      location: { file: "/repo/e2e/claim-ownership.spec.ts" },
    };
    reporter.onTestEnd(test as never, { startTime: new Date(1000), duration: 250 } as never);

    const [file] = readdirSync(dir);
    expect(file).toMatch(/^tests-.*\.ndjson$/);
    expect(JSON.parse(readFileSync(join(dir, file), "utf8"))).toEqual({
      start: 1000,
      end: 1250,
      group: "automation",
      spec: "claim-ownership.spec.ts",
    });
  });

  it("writes nothing without a directory", () => {
    const reporter = new RequestLogReporter({ dir: "" });
    expect(() => reporter.onTestEnd({} as never, {} as never)).not.toThrow();
  });
});
