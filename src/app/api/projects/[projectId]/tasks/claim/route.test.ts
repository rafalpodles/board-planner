import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/worker-service", () => ({
  verifyWorkerCredential,
  verdictFor,
  PROTOCOL_VERSION: 1,
}));
vi.mock("@/lib/task-service", () => ({ claimNextTask, releaseExpiredTasks, releaseTask: vi.fn() }));
// Resolving an agent is tested in agent-snapshot.test.ts; here it only has to succeed so the route
// gets past it
vi.mock("@/lib/agent-snapshot", () => ({
  snapshotFor: vi.fn(async () => ({ agentId: "a1", name: "Default", sequence: [] })),
}));
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
  claimNextTask.mockResolvedValue(hydrated({ _id: "t1", taskNumber: 1 }));
  releaseExpiredTasks.mockResolvedValue(0);
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

  it("reports an empty queue as 204", async () => {
    claimNextTask.mockResolvedValue(null);

    const response = await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(response.status).toBe(204);
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

// The claim is an assignment now, so the worker's identity has to reach task-service — without it
// a task is claimed and left unassigned, and the "never touch an assigned task" rule buys nothing.
describe("the worker's identity travels with the claim", () => {
  it("passes the identity the worker registered with", async () => {
    verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [], identity: "u-worker" });
    claimNextTask.mockResolvedValue(hydrated({ _id: "t1" }));

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1", "u-worker");
  });
});
