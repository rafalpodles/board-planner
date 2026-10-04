import { describe, it, expect, vi, beforeEach } from "vitest";
import sift from "sift";

const verifyWorkerCredential = vi.fn();
const getAuthUser = vi.fn();
const projectFindOne = vi.fn();
const userFindOne = vi.fn();
const userExists = vi.fn();
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
  Project: { findOne: projectFindOne },
}));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne, exists: userExists } }));
const taskExists = vi.fn();
const taskFindOne = vi.fn();
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, exists: taskExists } }));

const { withProjectAccessOrWorker } = await import("./middleware");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");
const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const IDENTITY_ID = "69a52e3b399b27d3cbb2c5b7";
const OWNER_ID = "69a52e3b399b27d3cbb2c5c9";
const REMOTE = "git@github.com:owner/repo.git";

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
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
  return { _id: IDENTITY_ID, username: "worker-w1", fullName: "Owner · MacBook", role: "member" };
}

// Two different accounts, because they answer two different questions: identity is which machine
// acted, owner is whose machine it is — and only the owner's grants decide what it may reach.
function ownerDoc() {
  return { _id: OWNER_ID, username: "owner", fullName: "Owner", role: "member" };
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
  projectFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(projectDoc()) }) });
  userFindOne.mockImplementation((filter: { _id: string }) =>
    Promise.resolve(String(filter._id) === OWNER_ID ? ownerDoc() : identityDoc())
  );
  accessibleProjectIds.mockResolvedValue([PROJECT_ID]);
  // Nothing in flight unless a test says so
  taskExists.mockResolvedValue(null);
  userExists.mockResolvedValue(null);
});

describe("a worker reporting with its own credential", () => {
  it("lets it through to a project it is assigned to", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  // BP-832. The same second line withWorker has: its credential was scrambled at deactivation
  it("refuses a machine whose owner is deactivated", async () => {
    userExists.mockResolvedValue({ _id: OWNER_ID });
    const handler = vi.fn();

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
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
    projectFindOne.mockReturnValue({ select: () => ({ _id: PROJECT_ID }) });

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
    projectFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(projectDoc({ worker: { enabled: false } })) }),
    });
    const handler = vi.fn();

    const res = await withProjectAccessOrWorker(handler)(workerRequest(), context());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a project an instance admin locked, though its owner switched workers on", async () => {
    projectFindOne.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve(projectDoc({ worker: { enabled: true, lockedByInstance: true } })),
      }),
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
    const HELD = "69a52e3b399b27d3cbb2c5d1";
    const OTHER = "69a52e3b399b27d3cbb2c5d2";
    const taskContext = (taskId?: string) => ({
      params: Promise.resolve({ projectId: PROJECT_ID, ...(taskId ? { taskId } : {}) }),
    });
    const holdsOnly = (held: string) =>
      taskExists.mockImplementation(async (query: { _id?: string }) =>
        query._id === undefined || query._id === held ? { _id: held } : null
      );

    it("reports through even though its owner reaches nothing", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
      holdsOnly(HELD);
      const handler = vi.fn().mockResolvedValue(new Response("ok"));

      const res = await withProjectAccessOrWorker(handler)(workerRequest(), taskContext(HELD));

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("reports through when the grant was revoked mid-run", async () => {
      accessibleProjectIds.mockResolvedValue(["some-other-project"]);
      holdsOnly(HELD);
      const handler = vi.fn().mockResolvedValue(new Response("ok"));

      expect(
        (await withProjectAccessOrWorker(handler)(workerRequest(), taskContext(HELD))).status
      ).toBe(200);
    });

    // runId, not workerId: workerId is left behind as history when a run ends, so keying on it
    // would let a finished task grant its worker access to the project for good
    it("asks for a live run of this very task, in this project, held by this worker", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ owner: null }));
      holdsOnly(HELD);

      await withProjectAccessOrWorker(vi.fn().mockResolvedValue(new Response("ok")))(
        workerRequest(),
        taskContext(HELD)
      );

      expect(taskExists).toHaveBeenCalledWith({
        _id: HELD,
        project: PROJECT_ID,
        "execution.workerId": "w1",
        "execution.runId": { $nin: ["", null] },
        tenant: DEFAULT_TENANT_ID,
      });
    });

    // BP-736: a lock landing mid-run lets that run finish and report, and nothing else
    // BP-758: the same narrowing without a lock. A grant revoked mid-run, or a project whose
    // workers were switched off, used to leave the machine every task on the board.
    describe("when the project merely stopped serving this machine", () => {
      beforeEach(() => {
        accessibleProjectIds.mockResolvedValue(["some-other-project"]);
        holdsOnly(HELD);
      });

      it("refuses a route about any other task on the project", async () => {
        const handler = vi.fn();

        const res = await withProjectAccessOrWorker(handler)(workerRequest(), taskContext(OTHER));

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });

      it("refuses a task route whose number matches nothing", async () => {
        const handler = vi.fn();

        taskFindOne.mockReturnValue({ select: async () => null });

        const res = await withProjectAccessOrWorker(handler)(workerRequest(), taskContext("999"));

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });

      it("gives a route naming no task nothing at all", async () => {
        const handler = vi.fn();

        expect((await withProjectAccessOrWorker(handler)(workerRequest(), taskContext())).status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });

      it("still lets it read the board the run reports into", async () => {
        const handler = vi.fn().mockResolvedValue(new Response("ok"));

        const res = await withProjectAccessOrWorker(handler, { reach: "board" })(
          workerRequest(),
          taskContext()
        );

        expect(res.status).toBe(200);
      });
    });

    describe("when an instance admin has locked the project", () => {
      const lockedContext = taskContext;

      beforeEach(() => {
        projectFindOne.mockReturnValue({
          select: () => ({
            lean: () =>
              Promise.resolve(projectDoc({ worker: { enabled: true, lockedByInstance: true } })),
          }),
        });
        holdsOnly(HELD);
      });

      it("lets the held task's own routes through", async () => {
        const handler = vi.fn().mockResolvedValue(new Response("ok"));

        const res = await withProjectAccessOrWorker(handler)(workerRequest(), lockedContext(HELD));

        expect(res.status).toBe(200);
        expect(taskExists).toHaveBeenCalledWith(expect.objectContaining({ _id: HELD }));
      });

      it("refuses a route about any other task on the project", async () => {
        const handler = vi.fn();

        const res = await withProjectAccessOrWorker(handler)(workerRequest(), lockedContext(OTHER));

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });

      it("keeps the board read the run needs for its columns", async () => {
        const handler = vi.fn().mockResolvedValue(new Response("ok"));

        expect(
          (await withProjectAccessOrWorker(handler, { reach: "board" })(workerRequest(), lockedContext()))
            .status
        ).toBe(200);
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

    // A switched-off machine is refused before any of this: the kill switch is not a permissions
    // question and must not be softened by holding a task
    it("does not let a killed worker report either", async () => {
      verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false }));
      holdsOnly(HELD);

      expect(
        (await withProjectAccessOrWorker(vi.fn())(workerRequest(), taskContext(HELD))).status
      ).toBe(403);
    });
  });

  /**
   * BP-758. The outcome record leaves the outbox after the run's own final status change has
   * cleared `execution.runId`, so no held run is left to exempt it — and a project locked, switched
   * off or ungranted mid-run lost the run's history and cost. For a machine the project no longer
   * serves, the record proves itself by the run it names, within the lease, and reaches that run's
   * task and nothing else. A machine the project serves keeps what it always had.
   */
  describe("a run's outcome record", () => {
    const OWN = "69a52e3b399b27d3cbb2c5e1";
    const OTHER = "69a52e3b399b27d3cbb2c5e2";
    const RUN_ID = "0f8c1e5a-7d7b-4c43-9a55-3f1f5f0f2a11";
    const recent = () => new Date(Date.now() - 5 * 60_000);

    type Execution = { workerId: string; runId?: string; lastRunId?: string; startedAt: Date };
    // Evaluated by a real query matcher, so a clause the middleware drops or loosens changes which
    // of these documents it finds
    function taskDocs(docs: Array<{ _id: string; execution: Execution }>) {
      // A key set to undefined is not a missing one to a matcher, and missing is what Mongo stores
      const stored = docs.map((doc) => ({
        ...doc,
        project: PROJECT_ID,
        tenant: DEFAULT_TENANT_ID,
        execution: Object.fromEntries(
          Object.entries(doc.execution).filter(([, value]) => value !== undefined)
        ),
      }));
      taskExists.mockImplementation(async (query: Record<string, unknown>) => {
        const match = stored.find(sift(query as never));
        return match ? { _id: match._id } : null;
      });
    }
    // The run ended: runId is gone, lastRunId, workerId and startedAt stay behind on OWN alone
    const ranOwn = (execution: Partial<Execution> = {}) =>
      taskDocs([
        { _id: OWN, execution: { workerId: "w1", lastRunId: RUN_ID, startedAt: recent(), ...execution } },
        { _id: OTHER, execution: { workerId: "w2", lastRunId: "their-run", startedAt: recent() } },
      ]);

    function recordRequest(body: Record<string, unknown>) {
      return new Request(`https://example.com/api/projects/${PROJECT_ID}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer cpw_secret", "x-worker-id": "w1" },
        body: JSON.stringify({ outcome: "merged", taskKey: "BP-1", ...body }),
      });
    }

    const send = (body: Record<string, unknown>, handler = vi.fn().mockResolvedValue(new Response("ok", { status: 201 }))) =>
      withProjectAccessOrWorker(handler, { reach: "runRecord" })(recordRequest(body), context());

    describe("from a machine the project no longer serves", () => {
      beforeEach(() => {
        projectFindOne.mockReturnValue({
          select: () => ({
            lean: () =>
              Promise.resolve(projectDoc({ worker: { enabled: true, lockedByInstance: true } })),
          }),
        });
      });

      it("goes through for the run it ran, after it ended, on a locked project", async () => {
        ranOwn();

        expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(201);
      });

      it("goes through when workers were switched off or the grant revoked mid-run", async () => {
        projectFindOne.mockReturnValue({
          select: () => ({ lean: () => Promise.resolve(projectDoc({ worker: { enabled: false } })) }),
        });
        accessibleProjectIds.mockResolvedValue([]);
        ranOwn();

        expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(201);
      });

      // The handler reads the body again, so the middleware must not have consumed it
      it("leaves the body for the handler to read", async () => {
        ranOwn();
        const handler = vi.fn(async (request: Request) => Response.json(await request.json()));

        const res = await send({ taskId: OWN, runId: RUN_ID }, handler);

        expect((await res.json()).runId).toBe(RUN_ID);
      });

      it("refuses a record for another task, finally, and says so in the server log", async () => {
        ranOwn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const handler = vi.fn();

        const res = await send({ taskId: OTHER, runId: RUN_ID }, handler);

        // 422 because it is final: the worker's outbox drops it instead of retrying behind it
        expect(res.status).toBe(422);
        expect(handler).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`task ${OTHER}`));
        expect(warn.mock.calls[0][0]).toContain(RUN_ID);
        expect(warn.mock.calls[0][0]).toContain("machine w1");
        warn.mockRestore();
      });

      it("refuses a run this machine did not run on that task", async () => {
        ranOwn();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect((await send({ taskId: OWN, runId: "some-other-run" })).status).toBe(422);
      });

      // BP-758 review: acceptance used to never expire, and the record's detail is what the next
      // claim hands the agent as the previous rejection
      it("refuses the record once the run's lease has run out", async () => {
        ranOwn({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000) });
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(422);
      });

      it("still takes it just inside the lease", async () => {
        ranOwn({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 + 60_000) });

        expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(201);
      });

      // Claimed on a server from before BP-758, finished on this one: no lastRunId was ever written
      describe("for a task claimed before lastRunId existed", () => {
        it("goes through for the machine that ran it", async () => {
          ranOwn({ lastRunId: undefined });

          expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(201);
        });

        it("refuses any other machine", async () => {
          ranOwn({ lastRunId: undefined, workerId: "w9" });
          vi.spyOn(console, "warn").mockImplementation(() => {});

          expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(422);
        });
      });

      it("refuses a run id that is not text before it reaches a query", async () => {
        const handler = vi.fn();

        const res = await send({ taskId: OWN, runId: { $ne: "" } }, handler);

        expect(res.status).toBe(400);
        expect(taskExists).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
      });

      it("refuses a record naming no task id", async () => {
        expect((await send({ taskId: "not-an-id", runId: RUN_ID })).status).toBe(400);
      });

      // A worker from before BP-758 names no run: only the task it still holds
      describe("from a worker that sends no run id", () => {
        it("goes through for the task it still holds", async () => {
          taskDocs([{ _id: OWN, execution: { workerId: "w1", runId: RUN_ID, startedAt: recent() } }]);

          expect((await send({ taskId: OWN })).status).toBe(201);
        });

        it("is refused while it holds a different task on the board", async () => {
          taskDocs([
            { _id: OWN, execution: { workerId: "w1", startedAt: recent() } },
            { _id: OTHER, execution: { workerId: "w1", runId: RUN_ID, startedAt: recent() } },
          ]);
          const handler = vi.fn();

          expect((await send({ taskId: OWN }, handler)).status).toBe(403);
          expect(handler).not.toHaveBeenCalled();
        });

        it("is refused once the run it names nothing about has ended", async () => {
          ranOwn();

          expect((await send({ taskId: OWN })).status).toBe(403);
        });
      });
    });

    // BP-758 review: a released outcome requeues the task, which can be claimed again — by any
    // machine — before this record leaves the outbox, and that claim moves lastRunId on
    describe("from a machine the project serves", () => {
      it("goes through after the task was claimed again by another machine", async () => {
        taskDocs([{ _id: OWN, execution: { workerId: "w2", lastRunId: "their-run", startedAt: recent() } }]);

        expect((await send({ taskId: OWN, runId: RUN_ID })).status).toBe(201);
      });

      it("goes through without a run id, as a worker from before BP-758 sends it", async () => {
        expect((await send({ taskId: OWN })).status).toBe(201);
      });

      it("still refuses a run id that is not text", async () => {
        expect((await send({ taskId: OWN, runId: { $gt: "" } })).status).toBe(400);
      });
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
      scopedToDefaultTenant(),
      expect.objectContaining({ _id: OWNER_ID, username: "owner" })
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
