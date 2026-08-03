import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, PhaseEvent } from "./api.js";
import { ControlDeps } from "./control.js";
import { Runner } from "./exec.js";
import { LocalServer, LocalServerDeps } from "./local-server.js";
import { Store } from "./outbox.js";
import { Heartbeat, HeartbeatDeps } from "./registration.js";
import { createTelemetry } from "./telemetry.js";
import { ClaimedTask } from "./types.js";
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
  // The two server channels deliver the same standing command, so they must share the guard that
  // tells a redelivery from a fresh instruction.
  it("gives both server channels the one guarded dispatcher", () => {
    const { seen } = harness();

    expect(seen.heartbeat?.handlers).toBe(seen.control?.handlers);
  });

  // The socket still goes through commands.ts — a socket handed loop.pause() would skip the
  // acknowledgement — but by the local entry point. Handing it the server's record would order this
  // laptop's clock against the server's, and a fast laptop would drop a board-issued stop.
  it("keeps the socket out of the guard the server's clock writes to", () => {
    const { seen } = harness();

    expect(seen.local?.handlers).toBeDefined();
    expect(seen.local?.handlers).not.toBe(seen.heartbeat?.handlers);
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

// Nothing below is mocked between the agent's stdout and the two sinks. Everything part B built is
// inert until this join exists, and in part A every whole-branch defect lived in exactly this kind
// of seam: a producer in one task, a consumer in another, and no test that ran both at once.
describe("telemetry, from the agent's stdout to the two sinks", () => {
  const REPO = "/repos/demo";
  const SERVER_RUN_ID = "run-minted-by-the-server";
  const AGENT_SECRET = "cpw_deadbeef0123456789abcdef01234567";

  const CLAIMED: ClaimedTask = {
    taskId: "t1",
    projectId: "p1",
    taskKey: "CP-9",
    taskNumber: 9,
    title: "Add a thing",
    description: "body",
    acceptanceCriteria: [],
    attempts: 1,
    runId: SERVER_RUN_ID,
  };

  const RESULT_PAYLOAD = {
    status: "completed",
    summary: "did it",
    filesChanged: ["src/a.ts"],
    testsAdded: [],
    blockedReason: "",
  };

  // Shaped like the captured fixture: an init event that summarises to nothing, one tool call whose
  // input carries a secret, and the final result.
  const AGENT_STREAM = `${[
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "src/a.ts", content: `TOKEN=${AGENT_SECRET}` },
          },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.42,
      result: JSON.stringify(RESULT_PAYLOAD),
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;

  // 17 bytes: small enough that every line is cut, and a tick apart, the way a real pipe flushes
  function pipeFlushes(text: string): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += 17) parts.push(text.slice(index, index + 17));
    return parts;
  }

  function streamingRunner(claudeCalls: string[][] = []): Runner {
    return {
      async run(command, args, opts) {
        if (command === "claude") {
          claudeCalls.push(args);
          for (const part of pipeFlushes(AGENT_STREAM)) {
            opts.onStdout?.(part);
            await new Promise((resolve) => setImmediate(resolve));
          }
          return { code: 0, stdout: AGENT_STREAM, stderr: "", timedOut: false };
        }
        // bindRepository insists the path is its own toplevel; every other git call is content-free
        return {
          code: 0,
          stdout: args.includes("rev-parse") ? REPO : "",
          stderr: "",
          timedOut: false,
        };
      },
    };
  }

  // One full pass of the real loop: register, refresh, bind, claim, run, and stop. The diff comes
  // back empty, so the run ends where most real ones do — rejected at a gate, not merged.
  // postEvent is deliberately a plain function, never a vi.fn: a spy attaches its own handler to
  // whatever it returns, which quietly settles a rejection the source left unhandled — and that is
  // exactly the failure this suite has to be able to see.
  async function runOneTask(
    postEvent: ApiClient["postEvent"] = async () => {},
    policy?: Record<string, unknown>
  ) {
    const stateDir = mkdtempSync(join(tmpdir(), "cp-wiring-run-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });

    const telemetry = createTelemetry();
    const posted: PhaseEvent[] = [];
    const claudeCalls: string[][] = [];
    let claims = 0;

    const api = {
      claim: vi.fn<ApiClient["claim"]>(async () => (claims++ === 0 ? CLAIMED : null)),
      setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
      comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
      release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
      statusIds: vi
        .fn<ApiClient["statusIds"]>()
        .mockResolvedValue({ approved: "todo", review: "in_review", done: "done" }),
      columnIds: vi
        .fn<ApiClient["columnIds"]>()
        .mockResolvedValue(["todo", "in_progress", "in_review", "done"]),
      postEvent: (event: PhaseEvent) => {
        posted.push(event);
        return postEvent(event);
      },
    };

    let stop = (): void => {};
    const worker = createWorker({
      env: { ...ENV, CP_STATE_DIR: stateDir },
      runner: streamingRunner(claudeCalls),
      hostname: () => "host-1",
      // the loop only sleeps once it has nothing left to claim, which is one pass after the run
      sleep: async () => stop(),
      log: vi.fn(),
      logError: vi.fn(),
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          assignments: [{ project: "p1", proposedPath: REPO }],
          ...(policy ? { policy } : {}),
        }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () => api as unknown as ApiClient,
      createTelemetry: () => telemetry,
      startHeartbeat: () => fakeHeartbeat(),
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: () => ({ ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) }),
    });
    stop = () => worker.shutdown();

    try {
      await worker.run();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }

    return {
      api,
      posted,
      phases: posted.map((event) => event.phase),
      telemetry,
      worker,
      claudeArgs: claudeCalls[0] ?? [],
    };
  }

  // The whole run, as the board would see it: the three stage boundaries it got past, the three
  // events its own agent produced, and the three gates it reached before the empty diff was
  // rejected. Nothing is dropped here because every emission is separated by at least one await,
  // which is all dropWhenBusy's single in-flight slot needs to clear.
  it("carries a pipeline stage boundary to the server", async () => {
    const { api, phases } = await runOneTask();

    expect(api.claim).toHaveBeenCalled();
    expect(phases).toEqual([
      "claiming",
      "worktree",
      "agent",
      "agent",
      "agent",
      "gates:diff-size",
      "gates:protected-paths",
      "gates:test-presence",
    ]);
  });

  // The pipeline names "agent" exactly once, at the stage boundary. Every further one was produced
  // by parsing the agent's stdout mid-run, so more than one is proof the stream reached the server.
  it("carries an event off the agent's own stream to the server", async () => {
    const { phases, telemetry } = await runOneTask();

    expect(phases.filter((phase) => phase === "agent").length).toBeGreaterThan(1);
    // and it really is the stream: only a parsed tool_use can produce a tool
    expect(telemetry.recent()).toContainEqual({
      phase: "agent",
      tool: { name: "Edit", target: "src/a.ts" },
    });
  });

  // The whole path in one pass — the server's own policy JSON, through applyPolicy and configFor,
  // into the argv of the process that does the work. This is the join no unit test can see: config
  // knows the policy, executor knows the flag, and until now nothing carried one to the other.
  it("runs the agent on the model the server's policy names", async () => {
    const { claudeArgs } = await runOneTask(async () => {}, {
      model: "haiku",
      fallbackModel: "opus",
    });

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("haiku");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("opus");
  });

  it("runs the agent on today's models when the server's policy names none", async () => {
    const { claudeArgs } = await runOneTask();

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("opus");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("sonnet");
  });

  it("addresses every event to the task and the run the server itself minted", async () => {
    const { posted } = await runOneTask();

    expect(posted.length).toBeGreaterThan(0);
    for (const event of posted) {
      expect(event.taskId).toBe("t1");
      expect(event.runId).toBe(SERVER_RUN_ID);
    }
  });

  it("sends the server nothing the agent wrote", async () => {
    const { posted, telemetry } = await runOneTask();

    expect(JSON.stringify(posted)).not.toContain(AGENT_SECRET);
    expect(JSON.stringify(posted)).not.toContain("TOKEN=");
    expect(JSON.stringify(telemetry.recent())).not.toContain(AGENT_SECRET);
  });

  it("fills the socket's own view of the run from the same bus", async () => {
    const { telemetry } = await runOneTask();

    const phases = telemetry.recent().map((progress) => progress.phase);
    expect(phases).toContain("claiming");
    expect(phases).toContain("gates:diff-size");
    expect(telemetry.recent().at(-1)).toBeDefined();
  });

  it("posts nothing once the run is over, when the worker no longer holds the task", async () => {
    const { posted, telemetry } = await runOneTask();

    const afterTheRun = posted.length;
    telemetry.emit({ phase: "merge" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(afterTheRun).toBeGreaterThan(0);
    expect(posted.length).toBe(afterTheRun);
  });

  // emit() is called synchronously from inside a pipeline stage, so a rejection nobody handles is
  // an unhandledRejection, and Node's default action for one is to end the process. Asserted on the
  // process, because the run finishes either way and only the missing rejection tells them apart.
  it("leaves no unhandled rejection when the server refuses every event", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const refusing: ApiClient["postEvent"] = () =>
      Promise.reject(new Error("403: that run no longer holds this task"));

    process.on("unhandledRejection", record);
    let run;
    try {
      run = await runOneTask(refusing);
      // unhandledRejection is reported at the end of a turn, so give it one
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
    expect(run.posted.length).toBeGreaterThan(0);
    // and the run still reached the board with its verdict
    expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
  });
});
