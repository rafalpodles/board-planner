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

function call(method: "POST" | "PATCH", body: unknown, headers: Record<string, string> = authed) {
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
      record({
        files: [
          ...Array.from({ length: 3000 }, (_, at) => `src/f${at}.ts`),
          `src/${"d".repeat(900)}.ts`,
          "  src/padded.ts  ",
        ],
      })
    );

    await POST(req, ctx);
    const files = createDecision.mock.calls[0][3].files as string[];
    expect(files).toHaveLength(500);
    expect(Math.max(...files.map((file) => file.length))).toBeLessThanOrEqual(256);
  });

  /**
   * The bounds have to be arithmetic, not taste: `files` and `protectedFiles` at their maximum,
   * plus a patch at its maximum, must still fit the body cap even if every character escapes to
   * six bytes of JSON. A cap under the honest maximum is worse than no cap — the refusal is a 413
   * the worker logs, and the panel never appears at all.
   */
  it("cannot describe a change too large for the body it must arrive in", async () => {
    const path = "f".repeat(256);
    const files = Array.from({ length: 500 }, () => path);
    const { req, ctx } = call(
      "POST",
      record({ files, protectedFiles: files, patch: "x".repeat(220_000) })
    );

    expect((await POST(req, ctx)).status).toBe(201);
    const body = JSON.stringify(createDecision.mock.calls[0][3]);
    expect(Buffer.byteLength(body) * 6).toBeLessThan(4 * 1024 * 1024);
  });

  /**
   * The list is bounded for rendering; the count is not. The panel says "pushes the whole commit —
   * N files", and a sliced list would make that sentence describe five hundred files while the
   * push carried seven hundred — the same defect `patchTruncated` exists to prevent one field over.
   */
  it("counts every file, even where it only stores five hundred of them", async () => {
    const { req, ctx } = call(
      "POST",
      record({ files: Array.from({ length: 700 }, (_, at) => `src/f${at}.ts`) })
    );

    await POST(req, ctx);
    const stored = createDecision.mock.calls[0][3];
    expect(stored.files).toHaveLength(500);
    expect(stored.fileCount).toBe(700);
  });

  /**
   * The same for the subset the panel renders as chips: "what tripped the gate" must not be
   * smaller than what did.
   *
   * Two different lengths, deliberately. Built from one array, all four numbers are equal and a
   * copy-paste swap of the two sources — `protectedFileCount: files.total` — stays green.
   */
  it("counts each list from its own source, not from the other one", async () => {
    const { req, ctx } = call(
      "POST",
      record({
        files: Array.from({ length: 700 }, (_, at) => `src/f${at}.ts`),
        protectedFiles: Array.from({ length: 550 }, (_, at) => `scripts/s${at}.js`),
      })
    );

    await POST(req, ctx);
    const stored = createDecision.mock.calls[0][3];
    expect(stored.files).toHaveLength(500);
    expect(stored.fileCount).toBe(700);
    expect(stored.protectedFiles).toHaveLength(500);
    expect(stored.protectedFileCount).toBe(550);
  });

  /**
   * Marked rather than quietly shortened. `src/very/long` is a filename that does not exist;
   * `src/very/lon…` is visibly a cut one, and the chip is read as a path.
   */
  it("marks a path it had to cut, rather than inventing a shorter one", async () => {
    const long = `src/${"d".repeat(400)}.ts`;
    const { req, ctx } = call("POST", record({ files: [long] }));

    await POST(req, ctx);
    const [stored] = createDecision.mock.calls[0][3].files as string[];
    expect(stored).toHaveLength(256);
    expect(stored.endsWith("…")).toBe(true);
  });

  // A list carrying anything that is not a path is rebuilt, not trusted: it is rendered as the
  // whole change a person is consenting to
  it("drops entries that are not paths at all", async () => {
    const { req, ctx } = call(
      "POST",
      record({ files: ["src/a.ts", "", "   ", 7, null, { path: "x" }] })
    );

    await POST(req, ctx);
    expect(createDecision.mock.calls[0][3].files).toEqual(["src/a.ts"]);
  });

  it("trims a padded path rather than storing the padding", async () => {
    const { req, ctx } = call("POST", record({ files: ["  src/padded.ts  "] }));

    await POST(req, ctx);
    expect(createDecision.mock.calls[0][3].files).toEqual(["src/padded.ts"]);
  });

  /**
   * BP-381 review. Redaction can lengthen a patch two and a half times (`URL_USERINFO` rewrites
   * `a://b@` to `a://[redacted]@`), so the worker's own 200 000-character bound says nothing about
   * what arrives here — this cap is reached by ordinary redaction. A patch cut here and stored
   * with the worker's `patchTruncated: false` is a change the panel offers to accept while showing
   * only part of it: `acceptability()`'s refusal, reintroduced on the server side.
   */
  it("says the patch was cut when it cuts it, and withdraws the offer", async () => {
    const { req, ctx } = call("POST", record({ patch: "x".repeat(300_000) }));

    expect((await POST(req, ctx)).status).toBe(201);
    const stored = createDecision.mock.calls[0][3];
    expect(stored.patch).toHaveLength(220_000);
    expect(stored.patchTruncated).toBe(true);
    expect(stored.acceptable).toBe(false);
    expect(stored.unacceptableReason).toMatch(/not all of it/);
  });

  // The control: a patch that fits is stored whole and stays acceptable
  it("leaves a patch that fits alone", async () => {
    const { req, ctx } = call("POST", record({ patch: "x".repeat(1000) }));

    await POST(req, ctx);
    const stored = createDecision.mock.calls[0][3];
    expect(stored.patch).toHaveLength(1000);
    expect(stored.patchTruncated).toBe(false);
    expect(stored.acceptable).toBe(true);
  });

  // The worker's own verdict still stands on its own: a truncated diff it already knew about
  it("keeps the worker's truncation flag when the patch itself fits", async () => {
    const { req, ctx } = call(
      "POST",
      record({ patch: "x", patchTruncated: true, acceptable: false, unacceptableReason: "too big" })
    );

    await POST(req, ctx);
    expect(createDecision.mock.calls[0][3]).toMatchObject({
      patchTruncated: true,
      acceptable: false,
      unacceptableReason: "too big",
    });
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

  it("carries a real attempt count through", async () => {
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "failed", attempts: 3 });

    await PATCH(req, ctx);
    expect(settleDecision.mock.calls[0][3]).toMatchObject({ attempts: 3 });
  });

  // The panel renders this; a negative or fractional count is not one
  it.each([-1, 1.5, "3", null])("reads %j as no attempts rather than storing it", async (attempts) => {
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "failed", attempts });

    await PATCH(req, ctx);
    expect(settleDecision.mock.calls[0][3]).toMatchObject({ attempts: 0 });
  });

  /**
   * A worker credential is readable by the agent off its own disk, so this string is as
   * worker-supplied as the patch is — and the panel renders it as an href somebody clicks.
   */
  it.each([
    "https://evil.example.com/anything",
    "javascript:alert(1)",
    "https://github.com/o/r/pull/notanumber",
    "not a url at all",
    // The shape that borrows the tail while the host is somewhere else
    "https://evil.example.com/#/github.com/o/r/pull/1",
    "https://evil.example.com/?x=/o/r/pull/1",
    // Not tolerance for a caller that does not exist: `lastPrUrl` matches `/pull/` alone and
    // `openPr` shells out to `gh`, so this worker cannot produce a merge request url
    "https://gitlab.example.com/group/proj/-/merge_requests/7",
  ])("refuses a prUrl of %j", async (prUrl) => {
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "delivered", prUrl });

    expect((await PATCH(req, ctx)).status).toBe(400);
    expect(settleDecision).not.toHaveBeenCalled();
  });

  // The control: the two shapes a real delivery produces
  /**
   * `http` is admitted on purpose, matching `lastPrUrl` in the worker's `delivery.ts`. The two have
   * to agree: a settlement the board refuses is retried whole on the next poll, so a shape the
   * worker emits and this refuses is a push, a `gh pr create` and a 400 every poll until the
   * attempt ceiling stops it — with the board never told the url.
   */
  it.each([
    "https://github.com/owner/repo/pull/42",
    "http://ghe.internal/owner/repo/pull/7",
    "https://ghe.internal:8443/owner/repo/pull/7",
  ])("stores a real one: %s", async (prUrl) => {
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "delivered", prUrl });

    expect((await PATCH(req, ctx)).status).toBe(200);
    expect(settleDecision.mock.calls[0][3]).toMatchObject({ prUrl });
  });

  // Every settlement but `delivered` carries none, and an empty one is not a wrong one
  it("takes a settlement with no pull request at all", async () => {
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "refused", error: "moved" });

    expect((await PATCH(req, ctx)).status).toBe(200);
  });

  it("refuses a killed machine here too", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false }));
    const { req, ctx } = call("PATCH", { taskId: TASK_ID, state: "delivered" });

    expect((await PATCH(req, ctx)).status).toBe(403);
  });
});
