import { describe, it, expect, vi } from "vitest";
import { createApiClient } from "./api.js";

const config = {
  apiBaseUrl: "https://app.example.com",
  apiToken: "cp_token",
  projectId: "CP",
  workerId: "worker-a",
} as never;

describe("createApiClient", () => {
  it("returns null when the claim endpoint reports an empty queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never);
    expect(await api.claim("run-1")).toBeNull();
  });

  it("maps a claimed task onto ClaimedTask", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        taskNumber: 158,
        title: "Do the thing",
        description: "body",
        checklist: [{ text: "first", done: false }],
        execution: { attempts: 1 },
      }),
    });
    const api = createApiClient(config, fetchMock as never);

    const task = await api.claim("run-1");

    expect(task).toEqual({
      taskId: "t1",
      taskKey: "CP-158",
      taskNumber: 158,
      title: "Do the thing",
      description: "body",
      acceptanceCriteria: ["first"],
      attempts: 1,
    });
  });

  it("sends the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(config, fetchMock as never);
    await api.claim("run-1");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer cp_token");
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const api = createApiClient(config, fetchMock as never);
    await expect(api.claim("run-1")).rejects.toThrow(/500/);
  });

  it("sends the status via PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never);

    await api.setStatus("t1", "done");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/status");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ status: "done" }));
  });

  it("sends the comment via POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const api = createApiClient(config, fetchMock as never);

    await api.comment("t1", "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/comments");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ body: "hello" }));
  });

  it("drops checklist items without a string text field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _id: "t1",
        taskNumber: 158,
        title: "Do the thing",
        description: "body",
        checklist: [{ text: "first" }, { done: true }, { text: 42 }],
        execution: { attempts: 1 },
      }),
    });
    const api = createApiClient(config, fetchMock as never);

    const task = await api.claim("run-1");

    expect(task?.acceptanceCriteria).toEqual(["first"]);
  });

  it("releases via POST with no body, so the server owns the target column", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never);

    await api.release("t1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP/tasks/t1/release");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("charges the attempt when the release asks not to refund it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = createApiClient(config, fetchMock as never);

    await api.release("t1", { refund: false });

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
    const api = createApiClient(config, fetchMock as never);

    expect(await api.statusIds()).toEqual({
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
    const api = createApiClient(config, fetchMock as never);

    expect((await api.statusIds()).review).toBe("escalated");
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
    const api = createApiClient(config, fetchMock as never);

    expect(await api.statusIds()).toEqual({
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
    const api = createApiClient(config, fetchMock as never);

    expect((await api.statusIds()).review).toBe("early");
  });

  it("falls back to the seeded ids when a role is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ columns: [{ id: "doing", role: "active", order: 1 }] }),
    });
    const api = createApiClient(config, fetchMock as never);

    expect(await api.statusIds()).toEqual({
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
    const api = createApiClient(config, fetchMock as never);

    expect(await api.statusIds()).toEqual({
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
    const api = createApiClient(config, fetchMock as never);

    expect((await api.statusIds()).done).toBe("shipped");
  });

  it("reads the columns from the project endpoint a worker token can reach", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ columns: [] }),
    });
    const api = createApiClient(config, fetchMock as never);

    await api.statusIds();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example.com/api/projects/CP");
    expect(init.method).toBe("GET");
  });

  it("still reports the status when reading the error body fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream closed");
      },
    });
    const api = createApiClient(config, fetchMock as never);
    await expect(api.claim("run-1")).rejects.toThrow(/500/);
  });
});

describe("createApiClient addressed by ObjectId", () => {
  const byObjectId = { ...config, projectId: "69a52e3b399b27d3cbb2c5a5" } as never;

  function fetchFor(project: unknown) {
    return vi.fn().mockImplementation(async (url: string) =>
      url.endsWith("/tasks/claim")
        ? {
            ok: true,
            status: 200,
            json: async () => ({ _id: "t1", taskNumber: 158, title: "Do the thing", description: "" }),
          }
        : { ok: true, status: 200, json: async () => project }
    );
  }

  it("keys the task from the project's own key, not from the configured id", async () => {
    const api = createApiClient(byObjectId, fetchFor({ key: "CP", columns: [] }) as never);

    expect((await api.claim("run-1"))?.taskKey).toBe("CP-158");
  });

  it("reads the project key once, however many tasks it claims", async () => {
    const fetchMock = fetchFor({ key: "CP", columns: [] });
    const api = createApiClient(byObjectId, fetchMock as never);

    await api.claim("run-1");
    await api.claim("run-2");

    const projectReads = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/tasks/claim"));
    expect(projectReads).toHaveLength(1);
  });

  it("does not read the project at all while the queue is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = createApiClient(byObjectId, fetchMock as never);

    await api.claim("run-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the claimed task moving on the configured id when the project cannot be read", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/tasks/claim")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ _id: "t1", taskNumber: 158, title: "Do the thing", description: "" }),
        };
      }
      return { ok: false, status: 503, text: async () => "down" };
    });
    const api = createApiClient(byObjectId, fetchMock as never);

    expect((await api.claim("run-1"))?.taskKey).toBe("69a52e3b399b27d3cbb2c5a5-158");
  });
});
