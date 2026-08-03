import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const verifyWorkerCredential = vi.fn();
const workerFind = vi.fn();
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
  Worker: { find: workerFind, findById: workerFindById, findByIdAndUpdate: workerFindByIdAndUpdate },
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
// A scoped token is an API token, so both flags are set — the fixture said only tokenScoped and so
// could not have caught the unscoped-admin case below.
const SCOPED_TOKEN = {
  _id: "member-1",
  role: "member",
  tokenScoped: true,
  viaMachineCredential: true,
  allowedProjects: [PROJECT_A],
};

// The credential the worker used to have to hold: an API token with no project scope. It never
// reaches applyTokenScope, so tokenScoped stays false and it stayed an instance admin.
const UNSCOPED_ADMIN_TOKEN = {
  _id: "admin-1",
  role: "admin",
  viaMachineCredential: true,
  allowedProjects: [],
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
  workerFind.mockResolvedValue([]);
  workerFindById.mockResolvedValue(workerDoc());
  workerFindByIdAndUpdate.mockImplementation((_id, { $set }) =>
    Promise.resolve(workerDoc($set as Record<string, unknown>))
  );
  mockProjects([projectDoc()]);
});

describe("GET /api/workers/:workerId", () => {
  it("returns the caller's own record, without credentialHash", async () => {
    verifyWorkerCredential.mockResolvedValue(
      workerDoc({ lastSeenAt: new Date(), credentialHash: "should-never-reach-the-client" })
    );

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

  // Found by driving a real server: an unscoped admin API token passed the tokenScoped guard and
  // cleared lockedByInstance — the kill switch, lifted by exactly the credential the worker held.
  it("refuses an unscoped admin API token, which is still a machine credential", async () => {
    getAuthUser.mockResolvedValue(UNSCOPED_ADMIN_TOKEN);

    const response = await PATCH(patchRequest({ lockedByInstance: false }), ctx());

    expect(response.status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a plain member on an admin-only field", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);

    const response = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/instance-admin only/);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a project admin on an admin-only field — project admin is not instance admin", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    const response = await PATCH(patchRequest({ assignments: [] }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/instance-admin only/);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a plain member on a policy field when they admin none of the assigned projects", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);
    mockProjects([projectDoc({ admins: ["someone-else"] })]);

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/requires admin of every/);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // The whole trust model: admining one project a shared worker serves must not
  // grant control (or visibility) over another, unrelated project on that worker
  it("refuses a project admin of A when the worker is also assigned to B", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);
    workerFindById.mockResolvedValue(
      workerDoc({
        assignments: [
          { project: PROJECT_A, proposedPath: "/repo-a" },
          { project: PROJECT_B, proposedPath: "/Users/alice/repos/project-b-confidential" },
        ],
      })
    );
    mockProjects([projectDoc({ _id: PROJECT_A }), projectDoc({ _id: PROJECT_B, admins: ["someone-else"] })]);

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/requires admin of every/);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("allows a project admin on a policy field", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      { $set: { "policy.baseBranch": "develop", policyOverrides: ["baseBranch"] } },
      { new: true }
    );
  });

  it("writes each model setting to its own policy field", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    const response = await PATCH(
      patchRequest({ model: "haiku", fallbackModel: "sonnet", reviewModel: "opus" }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      {
        $set: {
          "policy.model": "haiku",
          "policy.fallbackModel": "sonnet",
          "policy.reviewModel": "opus",
          policyOverrides: ["model", "fallbackModel", "reviewModel"],
        },
      },
      { new: true }
    );
  });

  // A blank model reaches the worker as an empty --model flag, which fails every run it claims
  it("400s on a blank model setting instead of storing it", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    for (const field of ["model", "fallbackModel", "reviewModel"]) {
      const response = await PATCH(patchRequest({ [field]: "   " }), ctx());

      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(new RegExp(`^${field} must be a non-empty`));
    }
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Independent of the authorization gate above: the response must reflect only what
  // was verified, not whatever the write happens to return
  it("does not disclose a project the caller cannot see, even if assignments changed between the read and the write", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);
    workerFindById.mockResolvedValue(
      workerDoc({ assignments: [{ project: PROJECT_A, proposedPath: "/repo-a" }] })
    );
    // Simulates a concurrent instance-admin assignment change landing between the
    // authorization read and this write
    workerFindByIdAndUpdate.mockResolvedValue(
      workerDoc({
        assignments: [
          { project: PROJECT_A, proposedPath: "/repo-a" },
          { project: PROJECT_B, proposedPath: "/Users/alice/repos/project-b-confidential" },
        ],
      })
    );

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.assignments).toEqual([{ project: PROJECT_A, proposedPath: "/repo-a" }]);
    expect(JSON.stringify(json)).not.toContain(PROJECT_B);
    expect(JSON.stringify(json)).not.toContain("project-b-confidential");
  });

  it("returns the full assignments list to an instance admin, unfiltered", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    const bothAssignments = [
      { project: PROJECT_A, proposedPath: "/repo-a" },
      { project: PROJECT_B, proposedPath: "/repo-b" },
    ];
    workerFindById.mockResolvedValue(workerDoc({ assignments: bothAssignments }));
    workerFindByIdAndUpdate.mockResolvedValue(workerDoc({ assignments: bothAssignments }));

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(200);
    expect((await response.json()).assignments).toEqual(bothAssignments);
  });

  it("refuses a policy field on a worker with no assignments even for a project admin", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);
    workerFindById.mockResolvedValue(workerDoc({ assignments: [] }));

    const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(response.status).toBe(403);
    expect(projectFind).not.toHaveBeenCalled();
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
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
          policyOverrides: ["baseBranch", "pollIntervalMs"],
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

// Two live workers pointed at one checkout both build worktrees in it and both run git in it.
describe("PATCH /api/workers/:workerId — one checkout, one worker", () => {
  const OTHER_ID = "69a52e3b399b27d3cbb2c5b0";

  function otherWorker(overrides: Record<string, unknown> = {}) {
    return workerDoc({
      _id: OTHER_ID,
      name: "other-laptop",
      assignments: [{ project: PROJECT_A, proposedPath: "/repo" }],
      ...overrides,
    });
  }

  it("refuses an assignment a live worker already holds, and writes nothing", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFind.mockResolvedValue([otherWorker()]);

    const response = await PATCH(
      patchRequest({ assignments: [{ project: PROJECT_A, proposedPath: "/repo" }] }),
      ctx()
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/other-laptop/);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("excludes the worker being updated, so re-saving its own assignment is allowed", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFind.mockResolvedValue([]);

    const response = await PATCH(
      patchRequest({ assignments: [{ project: PROJECT_A, proposedPath: "/repo" }] }),
      ctx()
    );

    expect(response.status).toBe(200);
    expect(workerFind).toHaveBeenCalledWith({ _id: { $ne: WORKER_ID } });
  });

  it("allows the same project in a different checkout", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFind.mockResolvedValue([otherWorker()]);

    const response = await PATCH(
      patchRequest({ assignments: [{ project: PROJECT_A, proposedPath: "/another-repo" }] }),
      ctx()
    );

    expect(response.status).toBe(200);
  });

  // Refusing on behalf of a machine that is gone would leave no way to move its work elsewhere.
  it("lets an assignment move off a worker that has stopped reporting", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFind.mockResolvedValue([otherWorker({ lastSeenAt: new Date("2020-01-01T00:00:00.000Z") })]);

    const response = await PATCH(
      patchRequest({ assignments: [{ project: PROJECT_A, proposedPath: "/repo" }] }),
      ctx()
    );

    expect(response.status).toBe(200);
  });
});

// The list is the only record of intent: the schema materialises a default into every policy field
// at creation, so the stored value cannot say whether anyone chose it.
describe("PATCH /api/workers/:workerId — recording what the operator set", () => {
  it("records a field even when the value equals the default", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);

    await PATCH(patchRequest({ maxDiffLines: 400 }), ctx());

    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      { $set: { "policy.maxDiffLines": 400, policyOverrides: ["maxDiffLines"] } },
      { new: true }
    );
  });

  it("adds to the existing list rather than replacing it", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFindById.mockResolvedValue(workerDoc({ policyOverrides: ["model"] }));

    await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set.policyOverrides).toEqual([
      "model",
      "baseBranch",
    ]);
  });

  it("does not record the same field twice", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFindById.mockResolvedValue(workerDoc({ policyOverrides: ["baseBranch"] }));

    await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set.policyOverrides).toEqual(["baseBranch"]);
  });

  it("leaves the list alone when no policy field was touched", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);

    await PATCH(patchRequest({ enabled: false }), ctx());

    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("policyOverrides");
  });
});
