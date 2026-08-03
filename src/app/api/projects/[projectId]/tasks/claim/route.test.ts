import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const verdictFor = vi.fn();
const claimNextTask = vi.fn();
const releaseExpiredTasks = vi.fn();
const resolveProjectId = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/worker-service", () => ({
  verifyWorkerCredential,
  verdictFor,
  PROTOCOL_VERSION: 1,
}));
vi.mock("@/lib/task-service", () => ({ claimNextTask, releaseExpiredTasks }));
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

beforeEach(() => {
  vi.clearAllMocks();
  resolveProjectId.mockResolvedValue(OID);
  verifyWorkerCredential.mockResolvedValue({ _id: OID, assignments: [] });
  verdictFor.mockReturnValue({ ok: true });
  claimNextTask.mockResolvedValue({ _id: "t1", taskNumber: 1 });
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

    expect(claimNextTask).toHaveBeenCalledWith(OID, OID, "run-1");
  });

  it("resolves a project key before asking the verdict or the claim", async () => {
    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(resolveProjectId).toHaveBeenCalledWith("CP");
    expect(verdictFor.mock.calls[0][1]).toBe(OID);
  });

  // Otherwise locking the only worker of a project also stops the queue healing itself
  it("frees expired leases before the verdict can refuse the caller", async () => {
    verdictFor.mockReturnValue({ ok: false, reason: "locked" });

    await POST(request(authed), { params: Promise.resolve({ projectId: "CP" }) });

    expect(releaseExpiredTasks).toHaveBeenCalledWith(OID);
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
