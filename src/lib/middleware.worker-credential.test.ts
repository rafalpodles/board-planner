import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const getAuthUser = vi.fn();
const projectFindById = vi.fn();
const userFindById = vi.fn();
const check = vi.fn();
const accessibleProjectIds = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("./worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-service")>();
  return { ...actual, verifyWorkerCredential };
});
vi.mock("./auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
// The person branch consults check(); the worker branch consults accessibleProjectIds() through
// ownerReachableProjectIds, because a machine reaches exactly what its owner reaches (BP-358)
vi.mock("./grants", () => ({ check, accessibleProjectIds }));
vi.mock("@/models/project", () => ({
  Project: { findById: projectFindById, findOne: vi.fn() },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
const taskExists = vi.fn();
vi.mock("@/models/task", () => ({ Task: { findOne: vi.fn(), exists: taskExists } }));

const { withProjectAccessOrWorker } = await import("./middleware");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const IDENTITY_ID = "69a52e3b399b27d3cbb2c5b7";
const OWNER_ID = "69a52e3b399b27d3cbb2c5c9";
const REMOTE = "git@github.com:owner/repo.git";

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    identity: IDENTITY_ID,
    repos: [{ remote: REMOTE, path: "/checkout" }],
    // BP-305/BP-358: the reported repos narrow what this machine's owner can reach, they never
    // stand in for it
    owner: OWNER_ID,
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

// Two different accounts, because they answer two different questions: identity is which machine
// acted, owner is whose machine it is — and only the owner's grants decide what it may reach.
function ownerDoc() {
  return { _id: OWNER_ID, username: "rpo", fullName: "Rafal", role: "member" };
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
  userFindById.mockImplementation((id: string) =>
    Promise.resolve(String(id) === OWNER_ID ? ownerDoc() : identityDoc())
  );
  accessibleProjectIds.mockResolvedValue([PROJECT_ID]);
  // Nothing in flight unless a test says so
  taskExists.mockResolvedValue(null);
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

  // BP-335/BP-336: handlers must never read x-worker-id themselves — a session cookie with no
  // Bearer takes the person branch, where that header is attacker-set and unverified. So the
  // middleware hands down the id it actually verified, and the route tests that mock this away
  // cannot prove it does.
  it("hands the handler the worker id it verified the credential against", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(handler.mock.calls[0][1].workerId).toBe("w1");
  });

  it("gives the person branch no worker id, whatever header the request carries", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));
    getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });
    check.mockResolvedValue(true);
    projectFindById.mockReturnValue({ select: () => ({ _id: PROJECT_ID }) });

    // A cookie session — no Bearer — carrying a forged x-worker-id
    const forged = new Request(`https://example.com/api/projects/${PROJECT_ID}/tasks/t1/comments`, {
      method: "POST",
      headers: { "x-worker-id": "w1" },
    });

    await withProjectAccessOrWorker(handler)(forged, context());

    // Without this the two `?.` below short-circuit to undefined when the handler was never
    // reached, so the assertion would pass for the wrong reason if any gate above it changed
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0]?.[1]?.workerId).toBeUndefined();
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

  // BP-358: what the stored approved list used to answer. Resolved live, so a revoked grant reaches
  // the machine on its next call instead of leaving an approval behind that nothing revisits.
  it("refuses a project this machine's owner cannot reach", async () => {
    accessibleProjectIds.mockResolvedValue(["some-other-project"]);
    const handler = vi.fn();

    expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a machine with no owner at all", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
    const handler = vi.fn();

    expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // Not merely refused by an empty grant list: the owner is never looked up at all
    expect(accessibleProjectIds).not.toHaveBeenCalled();
  });

  /**
   * The paragraph at the top of withProjectAccessOrWorker: a worker must still be able to report
   * the outcome of a task it already holds, or refusing it strands that task in the active column
   * until the two-hour lease sweeps it and spends an attempt.
   *
   * BP-358 made that reachable in a new way — the reach is the OWNER's, and every machine enrolled
   * before BP-358 has none, so on the day this deploys every in-flight run would 403.
   */
  describe("a run this machine is already holding", () => {
    it("reports through even though its owner reaches nothing", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
      taskExists.mockResolvedValue({ _id: "t1" });
      const handler = vi.fn().mockResolvedValue(new Response("ok"));

      const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("reports through when the grant was revoked mid-run", async () => {
      accessibleProjectIds.mockResolvedValue(["some-other-project"]);
      taskExists.mockResolvedValue({ _id: "t1" });
      const handler = vi.fn().mockResolvedValue(new Response("ok"));

      expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(200);
    });

    // runId, not workerId: workerId is left behind as history when a run ends, so keying on it
    // would let a finished task grant its worker access to the project for good
    it("asks for a live run, in this project, held by this worker", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
      taskExists.mockResolvedValue({ _id: "t1" });

      await withProjectAccessOrWorker(vi.fn().mockResolvedValue(new Response("ok")))(
        workerRequest(),
        context()
      );

      expect(taskExists).toHaveBeenCalledWith({
        project: PROJECT_ID,
        "execution.workerId": "w1",
        "execution.runId": { $nin: ["", null] },
      });
    });

    // The exemption is for a task in flight, not a standing grant: with nothing held, an
    // unreachable project is still refused
    it("does not become a way in once the run has ended", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
      const handler = vi.fn();

      expect((await withProjectAccessOrWorker(handler)(workerRequest(), context())).status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    // A disabled or locked machine is refused before any of this: the kill switch is not a
    // permissions question and must not be softened by holding a task
    it("does not let a killed worker report either", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ lockedByInstance: true }));
      taskExists.mockResolvedValue({ _id: "t1" });

      expect(
        (await withProjectAccessOrWorker(vi.fn())(workerRequest(), context())).status
      ).toBe(403);
    });
  });

  // The identity is a `worker-<id>` machine account with no grants of its own. Reading reach off it
  // rather than off the owner would refuse every project on the instance, and both accounts are
  // members, so nothing about the outcome distinguishes them — only who was asked.
  it("asks the owner's account what it may reach, not the machine's own identity", async () => {
    await withProjectAccessOrWorker(vi.fn().mockResolvedValue(new Response("ok")))(
      workerRequest(),
      context()
    );

    expect(accessibleProjectIds).toHaveBeenCalledWith(
      expect.objectContaining({ _id: OWNER_ID, username: "rpo" })
    );
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
