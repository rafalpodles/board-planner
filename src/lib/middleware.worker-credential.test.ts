import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const getAuthUser = vi.fn();
const projectFindById = vi.fn();
const userFindById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("./worker-service", () => ({ verifyWorkerCredential }));
vi.mock("./auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById, findOne: vi.fn() },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("@/models/task", () => ({ Task: { findOne: vi.fn() } }));

const { withProjectAccessOrWorker } = await import("./middleware");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const IDENTITY_ID = "69a52e3b399b27d3cbb2c5b7";
const REMOTE = "git@github.com:owner/repo.git";

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    identity: IDENTITY_ID,
    repos: [{ remote: REMOTE, path: "/checkout" }],
    ...overrides,
  };
}

function projectDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROJECT_ID,
    repositoryUrl: "https://github.com/owner/repo",
    worker: { enabled: true },
    ...overrides,
  };
}

function identityDoc() {
  return { _id: IDENTITY_ID, username: "worker-w1", fullName: "Rafal · MacBook", role: "member" };
}

function workerRequest(headers: Record<string, string> = {}) {
  return new Request(`https://example.com/api/projects/${PROJECT_ID}/tasks/t1/comments`, {
    method: "POST",
    headers: {
      authorization: "Bearer cpw_secret",
      "x-worker-id": "w1",
      ...headers,
    },
  });
}

const context = () => ({ params: Promise.resolve({ projectId: PROJECT_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  verifyWorkerCredential.mockResolvedValue(workerDoc());
  projectFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(projectDoc()) }) });
  userFindById.mockResolvedValue(identityDoc());
});

describe("a worker reporting with its own credential", () => {
  it("lets it through to a project it is assigned to", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  // Comments are authored by whoever the handler is handed. Without this a worker's note on a task
  // reads as though a person wrote it — the falsified audit trail CP-241 exists to end.
  it("acts as the machine's own identity, not as anyone's account", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(handler.mock.calls[0][1].user.username).toBe("worker-w1");
  });

  // The kill switch and every other act that needs a person at a keyboard key on this
  it("marks the request as made by a machine credential", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(handler.mock.calls[0][1].user.viaMachineCredential).toBe(true);
  });

  it("never consults the person path when a worker credential is presented", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(getAuthUser).not.toHaveBeenCalled();
  });
});

describe("the grant is re-derived on every call", () => {
  it("refuses a project that is not enabled for workers", async () => {
    projectFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(projectDoc({ worker: { enabled: false } })) }),
    });
    const handler = vi.fn();

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  // This is what a static project-scoped token could not do: the scope has to follow the
  // assignments, not a list fixed when the token was minted
  it("refuses a project whose repository this machine does not report", async () => {
    verifyWorkerCredential.mockResolvedValue(
      workerDoc({ repos: [{ remote: "git@github.com:someone/else.git", path: "/x" }] })
    );
    const handler = vi.fn();

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a disabled worker", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false }));
    const handler = vi.fn();

    expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a worker locked by the instance, whatever the project says", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ lockedByInstance: true }));
    const handler = vi.fn();

    expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a worker that has no identity to act as", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ identity: null }));
    const handler = vi.fn();

    expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("what it does with anything that is not a worker", () => {
  // A rejected worker credential must not quietly fall through to the person path, where the same
  // Bearer string would be tried as an API token
  it("rejects a bad worker credential rather than retrying it as a person", async () => {
    verifyWorkerCredential.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(401);
    expect(getAuthUser).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("falls through to the ordinary person path when no worker id is presented", async () => {
    getAuthUser.mockResolvedValue(null);
    const handler = vi.fn();

    const request = new Request(`https://example.com/api/projects/${PROJECT_ID}/tasks/t1/comments`, {
      method: "POST",
      headers: { authorization: "Basic abc" },
    });
    const res = await withProjectAccessOrWorker(handler)(request, context());

    expect(getAuthUser).toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("does not treat a worker id without a Bearer credential as a worker", async () => {
    getAuthUser.mockResolvedValue(null);
    const handler = vi.fn();

    const request = new Request(`https://example.com/api/projects/${PROJECT_ID}/tasks/t1/comments`, {
      method: "POST",
      headers: { "x-worker-id": "w1" },
    });
    await withProjectAccessOrWorker(handler)(request, context());

    expect(verifyWorkerCredential).not.toHaveBeenCalled();
    expect(getAuthUser).toHaveBeenCalled();
  });
});
