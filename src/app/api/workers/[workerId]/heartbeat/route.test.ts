import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const touchWorker = vi.fn();

const projectFind = vi.fn();
const workerUpdateOne = vi.fn();
const workerFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({
  Project: { find: () => ({ select: () => ({ lean: projectFind }) }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: { updateOne: workerUpdateOne, find: () => ({ select: workerFind }) },
}));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential, touchWorker };
});

const { POST } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const PROJECT_ID = "69a52e3b399b27d3cbb2c5b7";
const REMOTE = "git@github.com:owner/repo.git";

function enabledProject() {
  return {
    _id: PROJECT_ID,
    githubRepo: "owner/repo",
    worker: { enabled: true, policy: { autoMerge: true }, policyOverrides: ["autoMerge"] },
  };
}

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKER_ID,
    enabled: true,
    lockedByInstance: false,
    version: "1.0.0",
    host: "mac.home",
    lastSeenAt: new Date(),
    createdAt: new Date("2026-06-01"),
    policy: { pollIntervalMs: 5000 },
    policyOverrides: ["pollIntervalMs"],
    repos: [{ remote: REMOTE, path: "/repo" }],
    // BP-305: assignments are the approved set narrowed by the reported repos
    approvedProjects: [PROJECT_ID],
    command: "",
    commandIssuedAt: null,
    ...overrides,
  };
}

function request(body: unknown = {}) {
  return {
    req: new Request(`http://localhost/api/workers/${WORKER_ID}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cpw_secret",
        "x-worker-id": WORKER_ID,
        "x-cp-protocol": "1",
      },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ workerId: WORKER_ID }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectFind.mockResolvedValue([enabledProject()]);
  workerUpdateOne.mockResolvedValue({});
  workerFind.mockResolvedValue([]);
  verifyWorkerCredential.mockResolvedValue(workerDoc());
  touchWorker.mockResolvedValue(undefined);
});

describe("POST /api/workers/:workerId/heartbeat", () => {
  // The one channel that survives SSE loss and a restart: the worker applies what this says,
  // and keys "already applied" on the issuance
  it("carries the standing command and its issuance", async () => {
    verifyWorkerCredential.mockResolvedValue(
      workerDoc({ command: "pause", commandIssuedAt: new Date("2026-08-01T12:00:00.000Z") })
    );
    const { req, ctx } = request();

    const response = await POST(req, ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.command).toBe("pause");
    expect(json.commandIssuedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("reports no issuance when no command has ever been issued", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.command).toBe("");
    expect(json.commandIssuedAt).toBeNull();
  });

  it("refuses a disabled worker with the abort verdict instead of a command", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false, command: "pause" }));
    const { req, ctx } = request();

    const response = await POST(req, ctx);

    expect(response.status).toBe(403);
    expect((await response.json()).abort).toBe(true);
    expect(touchWorker).not.toHaveBeenCalled();
  });

  // Only the fields an operator set. A worker that is handed the whole stored policy pins every
  // field forever, because the schema materialises a default into each one at creation — so a
  // later change to a default would never reach it.
  it("returns the machine's own pinned settings, and nothing else", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.policy).toEqual({ pollIntervalMs: 5000 });
  });

  it("sends nothing when the operator pinned nothing on this machine", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ policyOverrides: [] }));
    const { req, ctx } = request();

    expect((await (await POST(req, ctx)).json()).policy).toEqual({});
  });

  // The whole inversion in one assertion: a remote comes back, never a path.
  it("answers with assignments keyed by remote, carrying the project's own policy", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.assignments).toEqual([
      { project: PROJECT_ID, remote: REMOTE, policy: { autoMerge: true } },
    ]);
  });

  it("offers nothing for a project nobody enabled for workers", async () => {
    projectFind.mockResolvedValue([
      { ...enabledProject(), worker: { enabled: false, policy: {}, policyOverrides: [] } },
    ]);
    const { req, ctx } = request();

    expect((await (await POST(req, ctx)).json()).assignments).toEqual([]);
  });

  it("stores what the worker reported so the fleet console can show it", async () => {
    const reported = [{ remote: REMOTE, path: "/somewhere" }];
    const { req, ctx } = request({ repos: reported });

    await POST(req, ctx);

    expect(workerUpdateOne).toHaveBeenCalledWith(
      { _id: WORKER_ID },
      { $set: { repos: reported } }
    );
  });

  // An older worker that does not report yet must keep the inventory it already has, or it would
  // silently lose every project the moment it heartbeats.
  it("keeps the stored inventory when a heartbeat carries none", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(workerUpdateOne).not.toHaveBeenCalled();
    expect(json.assignments).toHaveLength(1);
  });
});

// Two worker processes sharing one working tree both run git in it. Different machines cannot, so
// only a same-host pair collides — and the one that got there first keeps it.
describe("one working tree, one worker", () => {
  // Registered earlier than the worker under test, so it is the one that keeps the checkout
  const otherOnSameHost = {
    _id: "w2",
    name: "second-process",
    host: "mac.home",
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date(),
    createdAt: new Date("2020-01-01"),
    repos: [{ remote: REMOTE, path: "/repo" }],
  };

  it("offers nothing for a checkout another live process on this host already has", async () => {
    workerFind.mockResolvedValue([otherOnSameHost]);
    const { req, ctx } = request({ repos: [{ remote: REMOTE, path: "/repo" }] });

    expect((await (await POST(req, ctx)).json()).assignments).toEqual([]);
  });

  it("still offers it when the other worker is on a different machine", async () => {
    workerFind.mockResolvedValue([{ ...otherOnSameHost, host: "other-laptop" }]);
    const { req, ctx } = request({ repos: [{ remote: REMOTE, path: "/repo" }] });

    expect((await (await POST(req, ctx)).json()).assignments).toHaveLength(1);
  });

  it("takes the checkout over once the other process has gone stale", async () => {
    const stale = { ...otherOnSameHost, lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) };
    workerFind.mockResolvedValue([stale]);
    const { req, ctx } = request({ repos: [{ remote: REMOTE, path: "/repo" }] });

    expect((await (await POST(req, ctx)).json()).assignments).toHaveLength(1);
  });

  // Only the contested checkout drops out; a second, uncontested one must still be offered
  it("drops only the contested checkout, not the whole inventory", async () => {
    workerFind.mockResolvedValue([otherOnSameHost]);
    verifyWorkerCredential.mockResolvedValue(workerDoc({ approvedProjects: [PROJECT_ID, "p2"] }));
    projectFind.mockResolvedValue([
      enabledProject(),
      { _id: "p2", githubRepo: "owner/other", worker: { enabled: true, policy: {}, policyOverrides: [] } },
    ]);
    const { req, ctx } = request({
      repos: [
        { remote: REMOTE, path: "/repo" },
        { remote: "git@github.com:owner/other.git", path: "/other" },
      ],
    });

    const assignments = (await (await POST(req, ctx)).json()).assignments;

    expect(assignments.map((a: { project: string }) => a.project)).toEqual(["p2"]);
  });
});

// Preflight arrives from the worker, so it is rebuilt field by field like the checkout list rather
// than trusted. A machine that cannot run the work has to show that in the console instead of
// looking live, enabled and error-free.
describe("the preflight report a worker sends", () => {
  function preflightPatch() {
    return touchWorker.mock.calls[0]?.[1]?.preflight;
  }

  it("stores the verdict, the account and every check", async () => {
    const { req, ctx } = request({
      preflight: {
        ok: false,
        account: "someone@example.com",
        checks: [
          { name: "git", ok: true, detail: "/opt/homebrew/bin/git" },
          { name: "gh", ok: false, detail: "not authenticated" },
        ],
      },
    });

    await POST(req, ctx);

    expect(preflightPatch()).toMatchObject({
      ok: false,
      account: "someone@example.com",
      checks: [
        { name: "git", ok: true, detail: "/opt/homebrew/bin/git" },
        { name: "gh", ok: false, detail: "not authenticated" },
      ],
    });
    expect(preflightPatch()?.reportedAt).toBeInstanceOf(Date);
  });

  it("leaves the stored report alone when a worker sends none", async () => {
    const { req, ctx } = request({ version: "1.0.0" });

    await POST(req, ctx);

    expect(touchWorker.mock.calls[0]?.[1]).not.toHaveProperty("preflight");
  });

  it("drops a report whose verdict is not a boolean rather than storing half of one", async () => {
    const { req, ctx } = request({ preflight: { ok: "yes", checks: [] } });

    await POST(req, ctx);

    expect(touchWorker.mock.calls[0]?.[1]).not.toHaveProperty("preflight");
  });

  it("drops malformed checks but keeps the rest of the report", async () => {
    const { req, ctx } = request({
      preflight: {
        ok: true,
        checks: [{ name: "git", ok: true, detail: "fine" }, "nonsense", { ok: true }, { name: "npm", ok: "no" }],
      },
    });

    await POST(req, ctx);

    expect(preflightPatch()?.checks).toEqual([{ name: "git", ok: true, detail: "fine" }]);
  });

  it("caps what a worker can write into the console", async () => {
    const { req, ctx } = request({
      preflight: {
        ok: true,
        account: "a".repeat(500),
        checks: [{ name: "git", ok: true, detail: "b".repeat(2000) }],
      },
    });

    await POST(req, ctx);

    expect(preflightPatch()?.account).toHaveLength(200);
    expect(preflightPatch()?.checks[0].detail).toHaveLength(500);
  });
});
