import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const createDecision = vi.fn();
const settleDecision = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-decisions", () => ({ createDecision, settleDecision }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential };
});

const { POST, PATCH } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const TASK_ID = "69a52e3b399b27d3cbb2c5b7";
const COMMIT = "a".repeat(40);
const DIGEST = "b".repeat(64);

const authed = {
  "content-type": "application/json",
  authorization: "Bearer cpw_secret",
  "x-worker-id": WORKER_ID,
  "x-cp-protocol": "1",
};

function call(method: "POST" | "PATCH", body: unknown, headers = authed) {
  return {
    req: new Request(`http://localhost/api/workers/${WORKER_ID}/decisions`, {
      method,
      headers,
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ workerId: WORKER_ID }) },
  };
}

function record(over: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    runId: "run-1",
    gate: "protected-paths",
    files: ["package.json", "src/a.ts"],
    protectedFiles: ["package.json"],
    patch: "diff --git a/package.json b/package.json",
    patchTruncated: false,
    patchSha256: DIGEST,
    commit: COMMIT,
    taskKey: "CP-158",
    title: "Add a thing",
    acceptable: true,
    unacceptableReason: "",
    ...over,
  };
}

function workerDoc(over: Record<string, unknown> = {}) {
  return { _id: WORKER_ID, credentialHash: "h", enabled: true, lockedByInstance: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyWorkerCredential.mockResolvedValue(workerDoc());
  createDecision.mockResolvedValue({ ok: true, decision: { state: "pending" } });
  settleDecision.mockResolvedValue({ ok: true, decision: { state: "delivered" } });
});

/**
 * BP-381. Deliberately not on a project path: `withProjectAccessOrWorker` falls through to
 * `withProjectAccess` when no `x-worker-id` header is present, so a route under
 * `/api/projects/:id/...` would let any project member post a record with `acceptable: true` and
 * then accept it — the whole control, inverted.
 */
describe("POST /api/workers/:workerId/decisions", () => {
  it("needs a worker credential", async () => {
    const { req, ctx } = call("POST", record(), { "content-type": "application/json" });

    expect((await POST(req, ctx)).status).toBe(401);
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("refuses a machine the instance has switched off or killed", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ lockedByInstance: true }));
    const { req, ctx } = call("POST", record());

    const response = await POST(req, ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ abort: true });
  });

  it("passes the record through under the credential's own worker id", async () => {
    const { req, ctx } = call("POST", record());

    expect((await POST(req, ctx)).status).toBe(201);
    expect(createDecision).toHaveBeenCalledWith(
      TASK_ID,
      WORKER_ID,
      "run-1",
      expect.objectContaining({ commit: COMMIT, protectedFiles: ["package.json"] })
    );
  });

  /**
   * The commit is what a person is asked to accept and what the machine later pushes by name, so a
   * value git would not read as an object id is refused rather than stored — `--upload-pack=<cmd>`
   * in git's positional slot runs that command.
   */
  it.each(["", "main", "--upload-pack=touch /tmp/x", "zzzz"])(
    "refuses a commit of %j",
    async (commit) => {
      const { req, ctx } = call("POST", record({ commit }));

      expect((await POST(req, ctx)).status).toBe(400);
      expect(createDecision).not.toHaveBeenCalled();
    }
  );

  it("refuses a digest that is not one", async () => {
    const { req, ctx } = call("POST", record({ patchSha256: "nope" }));

    expect((await POST(req, ctx)).status).toBe(400);
  });

  it("refuses a record with no gate to name", async () => {
    const { req, ctx } = call("POST", record({ gate: "   " }));

    expect((await POST(req, ctx)).status).toBe(400);
  });

  // A record nobody may accept has to say why, or the panel offers no button and no explanation
  it("refuses an unacceptable record that gives no reason", async () => {
    const { req, ctx } = call("POST", record({ acceptable: false, unacceptableReason: "" }));

    expect((await POST(req, ctx)).status).toBe(400);
  });

  it("bounds the file list and each path in it", async () => {
    const { req, ctx } = call(
      "POST",
      record({ files: Array.from({ length: 3000 }, (_, at) => `src/f${at}.ts`) })
    );

    await POST(req, ctx);
    expect(createDecision.mock.calls[0][3].files).toHaveLength(2000);
  });

  it("answers the service's own refusal rather than a 500", async () => {
    createDecision.mockResolvedValue({ ok: false, error: "no live run", status: 409 });
    const { req, ctx } = call("POST", record());

    expect((await POST(req, ctx)).status).toBe(409);
  });
});

describe("PATCH /api/workers/:workerId/decisions", () => {
  it("settles under the credential's own worker id", async () => {
    const { req, ctx } = call("PATCH", {
      taskId: TASK_ID,
      state: "delivered",
      prUrl: "https://github.com/o/r/pull/7",
    });

    expect((await PATCH(req, ctx)).status).toBe(200);
    expect(settleDecision).toHaveBeenCalledWith(TASK_ID, WORKER_ID, "delivered", {
      prUrl: "https://github.com/o/r/pull/7",
      error: "",
      attempts: 0,
    });
  });

  /**
   * A machine reports what came of a verdict; it does not get to hand down one. Accepting is a
   * person's act, and a worker that could write `accepted` would be accepting its own change.
   */
  it.each(["accepted", "declined", "abandoned", "superseded", "pending"])(
    "refuses to settle a record as %s",
    async (state) => {
      const { req, ctx } = call("PATCH", { taskId: TASK_ID, state });

      expect((await PATCH(req, ctx)).status).toBe(400);
      expect(settleDecision).not.toHaveBeenCalled();
    }
  );

  it("refuses a task id that is not one", async () => {
    const { req, ctx } = call("PATCH", { taskId: "nope", state: "delivered" });

    expect((await PATCH(req, ctx)).status).toBe(400);
  });

  it("refuses a killed machine here too", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false }));
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "delivered" });

    expect((await PATCH(req, ctx)).status).toBe(403);
  });
});
