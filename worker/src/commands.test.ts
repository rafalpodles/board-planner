import { describe, it, expect, vi } from "vitest";
import { ApiClient } from "./api.js";
import { CommandHandlers, createCommandHandlers, createRunGuard } from "./commands.js";
import { connectControl } from "./control.js";
import { createLoop, Loop } from "./loop.js";
import { HeartbeatDeps, startHeartbeat } from "./registration.js";

function idleLoop(): Loop {
  return createLoop({
    pollIntervalMs: () => 1000,
    assignments: () => [],
    api: { claim: vi.fn<ApiClient["claim"]>().mockResolvedValue(null) } as unknown as ApiClient,
    execute: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  });
}

function heartbeatDeps(
  handlers: CommandHandlers,
  opts: { status?: number; command?: string; commandIssuedAt?: string | null } = {}
): HeartbeatDeps {
  const status = opts.status ?? 200;
  const fetchImpl = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      command: opts.command ?? "",
      commandIssuedAt: opts.commandIssuedAt ?? null,
    }),
  }));

  return {
    apiBaseUrl: "https://app.example.com",
    apiToken: "cp_admin_token",
    registration: { name: "worker-1", host: "host-1", platform: "darwin", version: "1.0.0" },
    store: {
      read: () => JSON.stringify({ workerId: "w1", credential: "cpw_x", heartbeatMs: 60_000 }),
      write: vi.fn(),
    },
    handlers,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: vi.fn(),
  };
}

function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(encoder.encode(frames[i++]));
    },
  });
}

function controlOver(frames: string[], handlers: CommandHandlers) {
  return connectControl({
    apiBaseUrl: "https://app.example.com",
    identitySource: { read: () => JSON.stringify({ workerId: "w1", credential: "cpw_x" }) },
    handlers,
    log: vi.fn(),
    fetchImpl: vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamOf(frames),
    })) as unknown as typeof fetch,
  });
}

describe("createRunGuard", () => {
  it("aborts the very signal the pipeline is running under, not a fresh controller", async () => {
    const runs = createRunGuard();
    const handlers = createCommandHandlers({ loop: idleLoop(), runs, ack: vi.fn() });
    const heartbeat = startHeartbeat(heartbeatDeps(handlers, { status: 403 }));
    heartbeat.onAbort(() => runs.abort());

    let handed: AbortSignal | undefined;
    await runs.under(async (signal) => {
      handed = signal;
      await heartbeat.tick();
    });

    expect(handed?.aborted).toBe(true);
  });

  it("leaves a finished run alone when a stop arrives after it", async () => {
    const runs = createRunGuard();

    let handed: AbortSignal | undefined;
    await runs.under(async (signal) => {
      handed = signal;
    });
    runs.abort();

    expect(handed?.aborted).toBe(false);
  });
});

describe("commands over the heartbeat", () => {
  it("pauses the loop from the heartbeat alone, with no control stream open", async () => {
    const loop = idleLoop();
    const handlers = createCommandHandlers({ loop, runs: { abort: vi.fn() }, ack: vi.fn() });
    const heartbeat = startHeartbeat(
      heartbeatDeps(handlers, { command: "pause", commandIssuedAt: "2026-08-01T12:00:00.000Z" })
    );

    await heartbeat.tick();

    expect(loop.paused()).toBe(true);
  });

  it("acknowledges a heartbeat-delivered command the same way the stream path does", async () => {
    const loop = idleLoop();
    const handlers = createCommandHandlers({
      loop,
      runs: { abort: vi.fn() },
      ack: (command) => heartbeat.ack(command),
    });
    const deps = heartbeatDeps(handlers, {
      command: "pause",
      commandIssuedAt: "2026-08-01T12:00:00.000Z",
    });
    const heartbeat = startHeartbeat(deps);

    await heartbeat.tick();
    await heartbeat.tick();

    const bodies = (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, init]) => JSON.parse(init.body)
    );
    expect(bodies[0].acked).toBeUndefined();
    expect(bodies[1].acked).toBe("pause");
  });

  it("ignores an empty command, so a worker with nothing standing keeps claiming", async () => {
    const loop = idleLoop();
    const handlers = createCommandHandlers({ loop, runs: { abort: vi.fn() }, ack: vi.fn() });

    await startHeartbeat(heartbeatDeps(handlers, { command: "" })).tick();

    expect(loop.paused()).toBe(false);
  });
});

describe("the same command over both transports", () => {
  it("does not apply a stream command a second time when the heartbeat repeats it", async () => {
    const abort = vi.fn();
    const handlers = createCommandHandlers({ loop: idleLoop(), runs: { abort }, ack: vi.fn() });
    const control = controlOver(
      ['event: command\ndata: {"command":"stop","commandIssuedAt":"2026-08-01T12:00:00.000Z"}\n\n'],
      handlers
    );

    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    control.close();

    await startHeartbeat(
      heartbeatDeps(handlers, { command: "stop", commandIssuedAt: "2026-08-01T12:00:00.000Z" })
    ).tick();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  // The other half: dedupe on the command name alone would swallow this and leave a run going
  it("applies a re-issued stop, because the issuance is newer even though the name is not", async () => {
    const abort = vi.fn();
    const handlers = createCommandHandlers({ loop: idleLoop(), runs: { abort }, ack: vi.fn() });
    const control = controlOver(
      ['event: command\ndata: {"command":"stop","commandIssuedAt":"2026-08-01T12:00:00.000Z"}\n\n'],
      handlers
    );

    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    control.close();

    await startHeartbeat(
      heartbeatDeps(handlers, { command: "stop", commandIssuedAt: "2026-08-01T12:30:00.000Z" })
    ).tick();

    expect(abort).toHaveBeenCalledTimes(2);
  });
});
