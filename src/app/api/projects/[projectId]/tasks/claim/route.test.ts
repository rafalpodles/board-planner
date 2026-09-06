import { describe, it, expect, vi, beforeEach } from "vitest";
import { BoardCannotClaim } from "@/lib/claim-refusal";

const verifyWorkerCredential = vi.fn();
const verdictFor = vi.fn();
const claimNextTask = vi.fn();
const releaseExpiredTasks = vi.fn();
const resolveProjectId = vi.fn();

const projectFindById = vi.fn();
const workerFindOthers = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({
  Project: { findById: () => ({ select: () => ({ lean: projectFindById }) }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: { find: () => ({ select: workerFindOthers }) },
}));
const ownerReachableProjectIds = vi.fn();
vi.mock("@/lib/worker-service", () => ({
  verifyWorkerCredential,
  verdictFor,
  ownerReachableProjectIds,
  PROTOCOL_VERSION: 1,
}));
const releaseTask = vi.fn();
vi.mock("@/lib/task-service", () => ({ claimNextTask, releaseExpiredTasks, releaseTask }));
// Which agent a project resolves to is agent-snapshot.test.ts's subject. What matters here is the
// branch where it resolves to none, which no test reached while this always succeeded.
const snapshotFor = vi.fn(async () => ({ agentId: "a1", name: "Default", sequence: [] }));
vi.mock("@/lib/agent-snapshot", () => ({ snapshotFor }));
vi.mock("@/lib/middleware", () => ({
  resolveProjectId,
  protocolOf: (r: Request) => Number(r.headers.get("x-cp-protocol") ?? NaN),
  withWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
      const auth = req.headers.get("authorization") ?? "";
      const id = req.headers.get("x-worker-id") ?? "";
      if (!auth.startsWith("Bearer ") || !id) {
        return new Response(JSON.stringify({ error: "Worker credential required" }), { status: 401 });
      }
      const worker = await verifyWorkerCredential(id, auth.slice(7));
      if (!worker) return new Response("{}", { status: 401 });
      return handler(req, { ...ctx, worker });
    },
}));

const { POST } = await import("./route");

const OID = "69a52e3b399b27d3cbb2c5a5";
// Deliberately not OID: the machine's id and its owner's are two different people's answers, and a
// fixture sharing one cannot tell "asked on behalf of the owner" from "asked on behalf of itself"
const OWNER = "69a52e3b399b27d3cbb2c5b7";

function request(headers: Record<string, string>, body: unknown = { runId: "run-1" }) {
  return new Request("http://localhost/api/projects/CP/tasks/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const authed = {
  authorization: "Bearer cpw_secret",
  "x-worker-id": OID,
  "x-cp-protocol": "1",
};

// What claimNextTask actually returns: a hydrated Mongoose document. Its fields are prototype
// getters, so a property read finds them and a spread does not — which is precisely the difference
// that let this route ship a body with every field one level down under `_doc`. A plain object
// here cannot catch that, so this fixture mimics the real shape rather than the convenient one.
function hydrated(fields: Record<string, unknown>) {
  const doc: Record<string, unknown> = {
    $__: {},
    $isNew: false,
    _doc: fields,
    toJSON: () => ({ ...fields }),
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(doc, key, { get: () => value, enumerable: false });
  }
  return doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  projectFindById.mockResolvedValue({ _id: "p1", githubRepo: "owner/repo", worker: { enabled: true } });
  workerFindOthers.mockResolvedValue([]);
  resolveProjectId.mockResolvedValue(OID);
  verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [] });
  verdictFor.mockReturnValue({ ok: true });
  ownerReachableProjectIds.mockResolvedValue(["p1"]);
  claimNextTask.mockResolvedValue(hydrated({ _id: "t1", taskNumber: 1 }));
  snapshotFor.mockResolvedValue({ agentId: "a1", name: "Default", sequence: [] });
  releaseExpiredTasks.mockResolvedValue(0);
  releaseTask.mockResolvedValue(undefined);
});

describe("POST /tasks/claim", () => {
  it("refuses a request with no worker credential", async () => {
    const response = await POST(request({}), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(401);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  // The control this whole plan exists for: it must hold on the polling path, with SSE gone
  it("refuses a locked worker even though its credential is valid", async () => {
    verdictFor.mockReturnValue({ ok: false, reason: "this worker is locked by the instance" });

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(403);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  it("claims as the worker the credential identifies, not a body field", async () => {
    await POST(request(authed, { runId: "run-1", workerId: "someone-else" }), {
      params: Promise.resolve({ projectId: "CP" }),
    });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", null);
  });

  /**
   * The claim and the snapshot must be asked the SAME question. `claimNextTask` matches a task the
   * owner handed themselves, and `snapshotFor` then refuses a personal agent that is not that
   * person's — a defence in depth that holds however the document reached the database, which is
   * what a rule enforced in every writer cannot promise.
   */
  it("resolves the agent on behalf of the machine's owner, not the machine", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: OID, owner: OWNER, assignments: [] });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", OWNER);
    expect(snapshotFor).toHaveBeenCalledWith(OID, undefined, OWNER);
  });

  // The fleet route populates `owner`, and String() on a populated document is its inspect output —
  // which claimNextTask answers by claiming nothing at all, silently, for the whole fleet
  it("reads the id out of a populated owner before either call sees it", async () => {
    verifyWorkerCredential.mockResolvedValue({
      _id: OID,
      owner: { _id: OWNER, username: "kasia" },
      assignments: [],
    });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", OWNER);
    expect(snapshotFor).toHaveBeenCalledWith(OID, undefined, OWNER);
  });

  it("resolves a project key before asking the verdict or the claim", async () => {
    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(resolveProjectId).toHaveBeenCalledWith("CP");
    // The verdict now decides against the project itself, since assignment is the project being
    // enabled and this machine reporting a checkout of its repository
    expect(verdictFor.mock.calls[0][1]).toMatchObject({ worker: { enabled: true } });
  });

  // Otherwise locking the only worker of a project also stops the queue healing itself
  it("frees expired leases before the verdict can refuse the caller", async () => {
    verdictFor.mockReturnValue({ ok: false, reason: "locked" });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(releaseExpiredTasks).toHaveBeenCalledWith(OID);
  });

  // The worker reads taskNumber, _id and checklist off the top level of this body. Nothing asserted
  // the body's shape, so the route could — and did — nest every field under `_doc` unnoticed.
  it("sends the task's own fields at the top level, beside the agent", async () => {
    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });
    const body = await response.json();

    expect(body).toMatchObject({ _id: "t1", taskNumber: 1 });
    expect(body.agent).toMatchObject({ agentId: "a1", name: "Default" });
    expect(body._doc).toBeUndefined();
  });

  // Holding a task no machine can run parks it behind the two-hour lease. 204 rather than an error
  // because the worker's loop treats a failed claim as a cycle failure and retries every poll —
  // nothing here is claimable until somebody fixes the agent, which is what 204 means.
  it("hands the task back and reports an empty queue when no agent resolves", async () => {
    snapshotFor.mockResolvedValue(null as never);

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(204);
    expect(releaseTask).toHaveBeenCalled();
  });

  /**
   * BP-358: with the attempt refunded this never terminated. The task went back to the head of the
   * approved column, sorted first again thirty seconds later, and attempts never accumulated — so
   * nothing escalated, nothing was logged, and every other claimable task on the project starved
   * behind it. Spending the attempt bounds it: three cycles, then releaseTask parks it in the
   * escalation column.
   */
  describe("a task naming an agent that resolves to nothing", () => {
    beforeEach(() => {
      snapshotFor.mockResolvedValue(null as never);
    });

    it("spends the attempt rather than refunding it", async () => {
      await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

      expect(releaseTask).toHaveBeenCalledWith(OID, "t1", {
        refund: false,
        workerId: OID,
      });
    });

    // Naming the holder, or worker A could park worker B's task in escalation mid-run
    it("names itself as the holder it is releasing on behalf of", async () => {
      await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

      expect(releaseTask.mock.calls[0][2].workerId).toBe(OID);
    });

    // The task moves back a column with no comment, no activity row and no run left to attach an
    // error to, so this is the only record that it happened at all
    it("logs the task and the agent that could not be resolved", async () => {
      claimNextTask.mockResolvedValue(hydrated({ _id: "t1", taskNumber: 1, agent: "a-empty" }));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

      expect(logged).toHaveBeenCalledWith(expect.stringContaining("t1"));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("a-empty"));
      logged.mockRestore();
    });

    // A failed release must not turn a 204 into a 500: the worker retries on its next poll either
    // way, and throwing here would read as the server being down
    it("still answers 204 when the release itself fails", async () => {
      releaseTask.mockRejectedValue(new Error("mongo is having a moment"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

      expect(response.status).toBe(204);
      logged.mockRestore();
    });
  });

  it("reports an empty queue as 204", async () => {
    claimNextTask.mockResolvedValue(null);

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(204);
  });

  // The control above is what this is distinct from: a board that cannot claim at all is not an
  // empty queue, and answering 204 for both left the worker looking idle on a board that was broken
  // (BP-512). The reason travels in the body, because the worker's log is the only place a
  // machine's operator will see it.
  it("says why a board cannot claim at all, rather than reporting an empty queue", async () => {
    claimNextTask.mockRejectedValue(new BoardCannotClaim("active"));

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/no column meaning In progress/);
  });

  // Anything else claimNextTask throws is a server fault, and dressing it as a board refusal would
  // hide an outage behind a message telling the operator to edit their columns
  it("does not turn an unrelated failure into a board refusal", async () => {
    claimNextTask.mockRejectedValue(new Error("mongo is having a moment"));

    await expect(
      POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) })
    ).rejects.toThrow("mongo is having a moment");
  });

  it("returns 404 when the project key does not resolve, without claiming", async () => {
    resolveProjectId.mockResolvedValue(null);

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "nope" }) });

    expect(response.status).toBe(404);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  it("returns 400 when runId is missing, without claiming", async () => {
    const response = await POST(request(authed, {}), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(400);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  it("returns 400 when runId is empty or whitespace, without claiming", async () => {
    for (const runId of ["", "   "]) {
      const response = await POST(request(authed, { runId }), {
        params: Promise.resolve({ projectId: "CP" }),
      });
      expect(response.status).toBe(400);
    }

    expect(claimNextTask).not.toHaveBeenCalled();
  });

  // BP-329. The runId lands in an aggregation `$set`, where a leading `$` is a field path rather
  // than text — so a claim carrying one stored an identity that was not the text sent: nothing at
  // all, or, on a task claimed once before, the previous run's workerId. The write wraps it in
  // `$literal` too; this is the half that refuses to carry it at all.
  it("returns 400 for a runId shaped like an aggregation expression, without claiming", async () => {
    for (const runId of ["$$REMOVE", "$execution.workerId", "$$ROOT", "run.1", "a".repeat(65)]) {
      const response = await POST(request(authed, { runId }), {
        params: Promise.resolve({ projectId: "CP" }),
      });
      expect(response.status, runId).toBe(400);
    }

    expect(claimNextTask).not.toHaveBeenCalled();
  });

  // The control: the shape a worker actually mints is `randomUUID()`, and a validator that refuses
  // that refuses every claim there is
  it("carries the uuid a worker mints straight through to the claim", async () => {
    const runId = "0c8cd177-0341-4880-8bea-490d0c9702a4";
    claimNextTask.mockResolvedValueOnce(null);

    const response = await POST(request(authed, { runId }), {
      params: Promise.resolve({ projectId: "CP" }),
    });

    expect(response.status).toBe(204);
    // The runId's position, not the whole call: what the other arguments carry is every other test
    // in this file's subject
    expect(claimNextTask.mock.calls[0][2]).toBe(runId);
  });

  it("returns 400 when the body is not valid JSON, without claiming", async () => {
    const malformed = new Request("http://localhost/api/projects/CP/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...authed },
      body: "{not json",
    });

    const response = await POST(malformed, { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(400);
    expect(claimNextTask).not.toHaveBeenCalled();
  });

  // request.json() resolves a literal `null` body instead of rejecting, so a naive
  // `.catch(() => ({}))` lets `null` straight through to the destructure
  it("returns 400 when the body is the JSON literal null, without claiming", async () => {
    const response = await POST(request(authed, null), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(400);
    expect(claimNextTask).not.toHaveBeenCalled();
  });
});

// The claim matched on the owner alone since BP-358, so the machine's own identity has no place
// in it: a task assigned to a `worker-<id>` account used to be claimable with no assignedBy check
// at all, and anyone able to reach the API can name that account.
describe("the worker's identity does not travel with the claim", () => {
  it("passes the owner and nothing else, even when the worker has an identity", async () => {
    verifyWorkerCredential.mockResolvedValue({
      _id: OID,
      assignments: [],
      identity: "u-worker",
      owner: "u-owner",
    });
    claimNextTask.mockResolvedValue(hydrated({ _id: "t1" }));

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", "u-owner");
  });
});

// BP-358: a machine claims its owner's work, so the owner set at enrolment has to reach
// task-service too — without it every claim is refused, owner or not.
describe("the worker's owner travels with the claim", () => {
  // The verdict decides whether this machine may serve the project at all, and since BP-358 that
  // answer comes from the owner's own grants rather than a list stored on the worker. Asserted on
  // the argument, because verdictFor is mocked here and would say ok either way.
  it("hands the verdict what its owner can reach", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [], owner: "u-owner" });
    ownerReachableProjectIds.mockResolvedValue(["p1", "p2"]);

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(ownerReachableProjectIds).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "u-owner" })
    );
    expect(verdictFor.mock.calls[0][5]).toEqual(["p1", "p2"]);
  });

  // IWorker["owner"] admits a populated document since the fleet route populates it, and
  // String(<document>) yields something that is not an id — which claimNextTask answers by
  // claiming nothing, silently, for every project the fleet serves
  it("reads the id off a populated owner rather than stringifying the document", async () => {
    verifyWorkerCredential.mockResolvedValue({
      _id: OID,
      assignments: [],
      owner: { _id: "u-owner", username: "owner", toString: () => "[object Object]" },
    });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", "u-owner");
  });

  it("passes the owner set at enrolment", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [], owner: "u-owner" });
    claimNextTask.mockResolvedValue(hydrated({ _id: "t1" }));

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", "u-owner");
  });
});
