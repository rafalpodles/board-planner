import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";
import { ControlDeps } from "./control.js";
import { Runner } from "./exec.js";
import { LocalServer, LocalServerDeps } from "./local-server.js";
import { Store } from "./outbox.js";
import { Heartbeat, HeartbeatDeps } from "./registration.js";
import { createTelemetry } from "./telemetry.js";
import { createWorker, WorkerDeps } from "./wiring.js";

const STATE_DIR = "/tmp/cp-wiring-test-state";

const ENV = {
  CP_API_URL: "https://app.example.com",
  CP_API_TOKEN: "cp_admin_token",
  CP_WORKER_NAME: "worker-1",
  CP_STATE_DIR: STATE_DIR,
};

const IDENTITY = JSON.stringify({ workerId: "w1", credential: "cpw_x", heartbeatMs: 60_000 });

function memoryStore(contents: string): Store {
  let text = contents;
  return {
    read: () => text,
    write: (next) => {
      text = next;
    },
  };
}

function fakeHeartbeat(): Heartbeat {
  return {
    tick: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    onAbort: vi.fn(),
    ack: vi.fn(),
    reportBindingError: vi.fn(),
  };
}

// Everything the wiring reaches for, replaced. No process ever spawns, no socket ever binds and no
// request ever leaves — what is under test is which component each seam was joined to.
function harness(overrides: Partial<WorkerDeps> = {}) {
  const heartbeat = fakeHeartbeat();
  const local: LocalServer = { ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };

  const seen = {
    heartbeat: undefined as HeartbeatDeps | undefined,
    control: undefined as ControlDeps | undefined,
    local: undefined as LocalServerDeps | undefined,
  };

  const control = { close: vi.fn() };
  const logError = vi.fn();

  const deps: Partial<WorkerDeps> = {
    env: ENV,
    runner: { run: vi.fn() } as unknown as Runner,
    hostname: () => "host-1",
    sleep: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    logError,
    uid: 501,
    realpath: (path) => path,
    stat: () => ({ uid: 501, mode: 0o40700 }),
    fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch,
    createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
    createApi: () =>
      ({
        claim: vi.fn().mockResolvedValue(null),
        release: vi.fn().mockResolvedValue(undefined),
      }) as unknown as ApiClient,
    startHeartbeat: (heartbeatDeps) => {
      seen.heartbeat = heartbeatDeps;
      return heartbeat;
    },
    connectControl: (controlDeps) => {
      seen.control = controlDeps;
      return control;
    },
    startLocalServer: (localDeps) => {
      seen.local = localDeps;
      return local;
    },
    ...overrides,
  };

  const worker = createWorker(deps);
  return { worker, seen, heartbeat, control, local, logError };
}

describe("the local socket's place in the wiring", () => {
  // The whole point of routing the socket through commands.ts: it owns the acknowledgement and the
  // recency guard. A socket handed loop.pause() would satisfy no assertion here.
  it("hands the socket the very dispatcher the server's two channels use", () => {
    const { seen } = harness();

    expect(seen.local?.handlers).toBe(seen.heartbeat?.handlers);
    expect(seen.local?.handlers).toBe(seen.control?.handlers);
  });

  it("puts the socket in the worker's own state directory", () => {
    const { seen } = harness();

    expect(seen.local?.socketPath).toBe(join(STATE_DIR, "worker.sock"));
  });

  it("reports the live loop's pause state, not a copy taken at startup", () => {
    const { seen } = harness();

    expect(seen.local?.paused()).toBe(false);
    seen.local?.handlers.pause("2026-08-02T12:00:00.000Z");

    expect(seen.local?.paused()).toBe(true);
  });

  it("gives the socket the same telemetry bus the run reports into", () => {
    const telemetry = createTelemetry();
    const { seen } = harness({ createTelemetry: () => telemetry });

    telemetry.emit({ phase: "agent" });

    expect(seen.local?.telemetry).toBe(telemetry);
    expect(seen.local?.telemetry.recent()).toEqual([{ phase: "agent" }]);
  });
});

describe("the worker's lifecycle", () => {
  it("closes the socket, the control stream and the heartbeat when the loop ends", async () => {
    const { worker, heartbeat, control, local } = harness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(local.close).toHaveBeenCalledTimes(1);
  });

  it("keeps claiming when the socket cannot be opened at all", async () => {
    const { worker, logError } = harness({
      startLocalServer: () => ({
        ready: Promise.reject(new Error("EADDRINUSE")),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(logError).toHaveBeenCalledWith(expect.stringContaining("local control socket unavailable"));
  });
});
