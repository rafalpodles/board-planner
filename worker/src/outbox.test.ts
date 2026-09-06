import { describe, it, expect, vi } from "vitest";
import { ApiClient } from "./api.js";
import { createOutbox, Store } from "./outbox.js";

function memoryStore(initial = ""): Store & { text: string } {
  return {
    text: initial,
    read() {
      return this.text;
    },
    write(text: string) {
      this.text = text;
    },
  };
}

function apiSpy(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    claim: vi.fn(),
    statusIds: vi.fn(),
    columnIds: vi.fn(),
    comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
    setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
    release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
    ...overrides,
  } as ApiClient;
}

describe("createOutbox", () => {
  it("delivers what it holds and empties itself", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    outbox.add({ kind: "status", projectId: "CP", taskId: "t1", status: "done" });
    const api = apiSpy();

    expect(await outbox.flush(api)).toEqual({ delivered: 2, pending: 0, dropped: 0 });
    expect(api.comment).toHaveBeenCalledWith("CP", "t1", "merged");
    expect(api.setStatus).toHaveBeenCalledWith("CP", "t1", "done");
    expect(outbox.pending()).toBe(0);
  });

  it("survives a restart, because a new instance reads the same store", async () => {
    const store = memoryStore();
    createOutbox(store, vi.fn()).add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });

    const afterRestart = createOutbox(store, vi.fn());

    expect(afterRestart.pending()).toBe(1);
    expect(await afterRestart.flush(apiSpy())).toMatchObject({ delivered: 1 });
  });

  it("keeps an undelivered report and counts the attempt", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 1, dropped: 0 });
    expect(outbox.pending()).toBe(1);
  });

  it("stops draining at the first failure rather than reordering around it", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    outbox.add({ kind: "status", projectId: "CP", taskId: "t1", status: "done" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) });

    const result = await outbox.flush(api);

    expect(result).toEqual({ delivered: 0, pending: 2, dropped: 0 });
    expect(api.setStatus).not.toHaveBeenCalled();
  });

  it("delivers on a later flush once the server comes back", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    await outbox.flush(apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) }));

    const api = apiSpy();
    expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 0, dropped: 0 });
    expect(api.comment).toHaveBeenCalledWith("CP", "t1", "merged");
  });

  it("gives up on a report the server will never accept", async () => {
    const store = memoryStore();
    const log = vi.fn();
    const outbox = createOutbox(store, log);
    outbox.add({ kind: "comment", projectId: "CP", taskId: "gone", body: "merged" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("404")) });

    for (let i = 0; i < 19; i += 1) await outbox.flush(api);
    expect(outbox.pending()).toBe(1);

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 0, dropped: 1 });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/giving up/);
  });

  it("carries the refund flag, so a requeue does not silently become a refund", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "release", projectId: "CP", taskId: "t1", refund: false });
    const api = apiSpy();

    await outbox.flush(api);

    expect(api.release).toHaveBeenCalledWith("CP", "t1", { refund: false });
  });

  it("releases with a refund when that is what was queued", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "release", projectId: "CP", taskId: "t1", refund: true });
    const api = apiSpy();

    await outbox.flush(api);

    expect(api.release).toHaveBeenCalledWith("CP", "t1");
  });

  it("ignores a corrupted line rather than losing the whole queue", async () => {
    const good = JSON.stringify({
      op: { kind: "comment", projectId: "CP", taskId: "t1", body: "ok" },
      attempts: 0,
    });
    const store = memoryStore(`not json\n${good}\n{"op":{}}\n`);

    expect(createOutbox(store, vi.fn()).pending()).toBe(1);
  });

  it("treats an unreadable store as empty instead of throwing into the run loop", async () => {
    const store: Store = {
      read() {
        throw new Error("no such file");
      },
      write: vi.fn(),
    };

    expect(createOutbox(store, vi.fn()).pending()).toBe(0);
  });

  it("keeps the newest reports when the queue is capped", () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    for (let i = 0; i < 505; i += 1) {
      outbox.add({ kind: "comment", projectId: "CP", taskId: `t${i}`, body: "x" });
    }

    expect(outbox.pending()).toBe(500);
    expect(store.text).toContain('"t504"');
    expect(store.text).not.toContain('"t0"');
  });
});
