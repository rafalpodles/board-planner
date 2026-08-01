import { describe, it, expect, vi } from "vitest";
import { ApiClient } from "./api.js";
import { createLoop, Loop } from "./loop.js";
import { ClaimedTask } from "./types.js";

const task = { taskId: "t1", taskKey: "CP-158" } as ClaimedTask;
const config = { pollIntervalMs: 30_000, concurrency: 1, workerId: "w" } as never;

function apiStub(claim: ApiClient["claim"]) {
  return {
    claim: vi.fn<ApiClient["claim"]>(claim),
    setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
    comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
    release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
    statusIds: vi.fn<ApiClient["statusIds"]>(),
    columnIds: vi.fn<ApiClient["columnIds"]>(),
  };
}

// Returns the given queue one task per claim, then reports the queue empty forever
function queue(...tasks: ClaimedTask[]): ApiClient["claim"] {
  const pending = [...tasks];
  return async () => pending.shift() ?? null;
}

function loopOver(
  api: ReturnType<typeof apiStub>,
  overrides: { execute?: (task: ClaimedTask) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {}
): { loop: Loop; execute: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(overrides.execute ?? (async () => undefined));
  // Stopping on the first idle sleep is what ends every test below
  const sleep = vi.fn(overrides.sleep ?? (async () => loop.stop()));
  const loop = createLoop({ config, api, execute, sleep, log: vi.fn() });
  return { loop, execute, sleep };
}

describe("createLoop", () => {
  it("runs a claimed task", async () => {
    const api = apiStub(queue(task));
    const { loop, execute } = loopOver(api);

    await loop.start();

    expect(execute).toHaveBeenCalledWith(task);
  });

  it("takes the next task without sleeping while the queue has work", async () => {
    const second = { ...task, taskId: "t2", taskKey: "CP-159" };
    const api = apiStub(queue(task, second));
    const { loop, execute, sleep } = loopOver(api);

    await loop.start();

    expect(execute.mock.calls.map(([t]) => t.taskKey)).toEqual(["CP-158", "CP-159"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("sleeps for the configured interval when the queue is empty", async () => {
    const api = apiStub(queue());
    const { loop, sleep } = loopOver(api);

    await loop.start();

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("keeps polling after a claim throws", async () => {
    let claims = 0;
    const api = apiStub(async () => {
      claims += 1;
      if (claims === 1) throw new Error("network down");
      return null;
    });
    const { loop } = loopOver(api, { sleep: async () => { if (claims >= 2) loop.stop(); } });

    await loop.start();

    expect(claims).toBeGreaterThanOrEqual(2);
  });

  it("keeps polling after a task run throws, rather than dying on one bad task", async () => {
    const api = apiStub(queue(task));
    const { loop, execute, sleep } = loopOver(api, {
      execute: async () => {
        throw new Error("pipeline exploded");
      },
    });

    await expect(loop.start()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
  });

  it("gives every cycle its own run id, so a retry cannot look like the first attempt", async () => {
    const api = apiStub(queue(task));
    const { loop } = loopOver(api);

    await loop.start();

    const runIds = api.claim.mock.calls.map(([runId]) => runId);
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(runIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stops before claiming again once it is asked to stop mid-task", async () => {
    const api = apiStub(queue(task, { ...task, taskId: "t2" }));
    const { loop, execute } = loopOver(api, {
      execute: async () => {
        loop.stop();
      },
    });

    await loop.start();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("claims nothing more once paused mid-task", async () => {
    const api = apiStub(queue(task, { ...task, taskId: "t2" }));
    let cycles = 0;
    const loop = createLoop({
      config,
      api,
      execute: async () => {
        loop.pause();
      },
      sleep: async () => {
        cycles += 1;
        if (cycles >= 3) loop.stop();
      },
      log: vi.fn(),
    });

    await loop.start();

    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(cycles).toBeGreaterThanOrEqual(3);
  });

  it("resumes claiming after resume", async () => {
    const api = apiStub(queue(task));
    let cycles = 0;
    const loop = createLoop({
      config,
      api,
      execute: vi.fn().mockResolvedValue(undefined),
      sleep: async () => {
        cycles += 1;
        if (cycles === 1) loop.resume();
        if (cycles >= 3) loop.stop();
      },
      log: vi.fn(),
    });
    loop.pause();

    await loop.start();

    expect(api.claim).toHaveBeenCalled();
  });
});

describe("draining undelivered reports", () => {
  it("drains before claiming, so a stranded task is settled first", async () => {
    const order: string[] = [];
    const api = apiStub(async () => {
      order.push("claim");
      return null;
    });
    const loop = createLoop({
      config,
      api,
      execute: vi.fn(),
      drain: async () => {
        order.push("drain");
      },
      sleep: async () => loop.stop(),
      log: vi.fn(),
    });

    await loop.start();

    expect(order).toEqual(["drain", "claim"]);
  });

  it("keeps working when the drain itself fails", async () => {
    const api = apiStub(queue(task));
    const execute = vi.fn().mockResolvedValue(undefined);
    const loop = createLoop({
      config,
      api,
      execute,
      drain: async () => {
        throw new Error("disk full");
      },
      sleep: async () => loop.stop(),
      log: vi.fn(),
    });

    await expect(loop.start()).resolves.toBeUndefined();
  });
});
