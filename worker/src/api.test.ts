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
