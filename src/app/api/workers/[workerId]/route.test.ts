import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const verifyWorkerCredential = vi.fn();
const workerFindById = vi.fn();
const workerFindByIdAndUpdate = vi.fn();
const projectFind = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/task", () => ({ Task: {} }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/worker", () => ({
  Worker: { findById: workerFindById, findByIdAndUpdate: workerFindByIdAndUpdate },
}));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential };
});
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));

const { GET, PATCH } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const PROJECT_A = "69a52e3b399b27d3cbb2c5a6";
const PROJECT_B = "69a52e3b399b27d3cbb2c5a7";

const INSTANCE_ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false, allowedProjects: [] };
const PLAIN_MEMBER = { _id: "member-1", role: "member", tokenScoped: false, allowedProjects: [] };
const PROJECT_ADMIN = {
  _id: "padmin-1",
  role: "member",
  tokenScoped: false,
  allowedProjects: [PROJECT_A],
};
const SCOPED_TOKEN = {
  _id: "member-1",
  role: "member",
  tokenScoped: true,
  allowedProjects: [PROJECT_A],
};

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKER_ID,
    name: "laptop-1",
    host: "mac.local",
    platform: "darwin",
    version: "1.0.0",
    protocolVersion: 1,
    assignments: [{ project: PROJECT_A, proposedPath: "/repo" }],
    policy: {
      baseBranch: "main",
      pollIntervalMs: 30_000,
      taskTimeoutMs: 1_800_000,
      maxDiffLines: 400,
      maxDiffFiles: 10,
      model: "opus",
    },
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date(),
    bindingError: "",
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T11:59:00.000Z"),
    ...overrides,
  };
}

function projectDoc(overrides: Record<string, unknown> = {}) {
  return { _id: PROJECT_A, owner: "someone-else", admins: ["padmin-1"], ...overrides };
}

function mockProjects(list: unknown[]) {
  projectFind.mockReturnValue({ select: () => Promise.resolve(list) });
}

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/workers/${WORKER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(workerId = WORKER_ID) {
  return { params: Promise.resolve({ workerId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  workerFindById.mockResolvedValue(workerDoc());
  workerFindByIdAndUpdate.mockImplementation((_id, { $set }) =>
    Promise.resolve(workerDoc($set as Record<string, unknown>))
  );
  mockProjects([projectDoc()]);
});

describe("GET /api/workers/:workerId", () => {
  it("returns the caller's own record, without credentialHash", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ lastSeenAt: new Date() }));

    const request = new Request(`http://localhost/api/workers/${WORKER_ID}`, {
      headers: { authorization: "Bearer cpw_secret", "x-worker-id": WORKER_ID },
    });
    const response = await GET(request, ctx());

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json._id).toBe(WORKER_ID);
    expect(json).not.toHaveProperty("credentialHash");
    expect(json.stale).toBe(false);
  });
});

describe("PATCH /api/workers/:workerId — authorization matrix", () => {
  it("refuses a scoped token outright, before even loading the worker", async () => {
    getAuthUser.mockResolvedValue(SCOPED_TOKEN);

    const response = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/interactive admin session/i);
    expect(workerFindById).not.toHaveBeenCalled();
  });

  it("refuses a plain member on an admin-only field", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);

    const response = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/instance-admin only/);
  });

  it("refuses a project admin on an admin-only field — project admin is not instance admin", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    const response = await PATCH(patchRequest({ assignments: [] }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/instance-admin only/);
  });

  it("refuses a plain member on a policy field when they admin none of the assigned projects", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);
    mockProjects([projectDoc({ admins: ["someone-else"] })]);

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/requires project admin/);
  });

  it("allows a project admin on a policy field", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      { $set: { "policy.baseBranch": "develop" } },
      { new: true }
    );
  });

  it("refuses a policy field on a worker with no assignments even for a project admin", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);
    workerFindById.mockResolvedValue(workerDoc({ assignments: [] }));

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(403);
    expect(projectFind).not.toHaveBeenCalled();
  });

  it("allows an instance admin on both admin and policy fields in one request", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFindById.mockResolvedValue(
      workerDoc({
        assignments: [
          { project: PROJECT_A, proposedPath: "/old-a" },
          { project: PROJECT_B, proposedPath: "/old-b" },
        ],
      })
    );

    const response = await PATCH(
      patchRequest({
        name: "renamed",
        enabled: false,
        assignments: [{ project: PROJECT_A, proposedPath: "/repo" }],
        baseBranch: "develop",
        pollIntervalMs: 5000,
      }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      {
        $set: {
          name: "renamed",
          enabled: false,
          assignments: [{ project: PROJECT_A, proposedPath: "/repo" }],
          "policy.baseBranch": "develop",
          "policy.pollIntervalMs": 5000,
        },
      },
      { new: true }
    );
    expect(logProjectAudit).toHaveBeenCalledTimes(2);
    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_A, "admin-1", "worker_updated", expect.any(String));
    expect(logProjectAudit).toHaveBeenCalledWith(PROJECT_B, "admin-1", "worker_updated", expect.any(String));
  });

  it("writes no audit row for a worker with no assignments", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFindById.mockResolvedValue(workerDoc({ assignments: [] }));

    const response = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(response.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/workers/:workerId — not found and validation", () => {
  beforeEach(() => getAuthUser.mockResolvedValue(INSTANCE_ADMIN));

  it("404s a syntactically invalid worker id without touching the database", async () => {
    const response = await PATCH(patchRequest({ enabled: false }), ctx("not-an-object-id"));

    expect(response.status).toBe(404);
    expect(workerFindById).not.toHaveBeenCalled();
  });

  it("404s a well-formed but unknown worker id", async () => {
    workerFindById.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(response.status).toBe(404);
  });

  it.each([
    ["invalid JSON syntax", "{not json"],
    ["the JSON literal null", "null"],
    ["a JSON array", "[]"],
    ["a bare JSON string", '"hello"'],
  ])("400s a malformed body: %s", async (_label, raw) => {
    const response = await PATCH(patchRequest(raw), ctx());

    expect(response.status).toBe(400);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("400s when the body has nothing recognized to update — command is not PATCH-able here", async () => {
    const response = await PATCH(patchRequest({ command: "pause" }), ctx());

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/nothing to update/i);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("400s on an assignment with a malformed project id", async () => {
    const response = await PATCH(
      patchRequest({ assignments: [{ project: "not-an-id", proposedPath: "/repo" }] }),
      ctx()
    );

    expect(response.status).toBe(400);
  });

  it("400s on an assignment with an empty proposedPath", async () => {
    const response = await PATCH(
      patchRequest({ assignments: [{ project: PROJECT_A, proposedPath: "   " }] }),
      ctx()
    );

    expect(response.status).toBe(400);
  });

  it("400s on a non-boolean enabled", async () => {
    const response = await PATCH(patchRequest({ enabled: "yes" }), ctx());

    expect(response.status).toBe(400);
  });

  it("400s on a non-positive-integer policy field", async () => {
    const response = await PATCH(patchRequest({ pollIntervalMs: -5 }), ctx());

    expect(response.status).toBe(400);
  });
});
