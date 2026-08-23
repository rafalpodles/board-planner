import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, PhaseEvent } from "./api.js";
import { ControlDeps } from "./control.js";
import { Runner } from "./exec.js";
import { LocalConfigView, LocalServer, LocalServerDeps } from "./local-server.js";
import { Store } from "./outbox.js";
import { PreflightReport } from "./preflight.js";
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

function fakeHeartbeat(bindingErrors: string[] = []): Heartbeat {
  return {
    tick: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    onAbort: vi.fn(),
    ack: vi.fn(),
    reportBindingError: vi.fn((message: string) => {
      bindingErrors.push(message);
    }),
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
  const logError = vi.fn<WorkerDeps["logError"]>();

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
    seen.local?.handlers.pause();

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

  // Since children run in their own session, a terminal Ctrl-C reaches only the worker. Without an
  // abort, shutdown is a flag checked between tasks — so stopping could mean waiting out the whole
  // task timeout with the agent still working.
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
  const REMOTE = "git@github.com:owner/repo.git";
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
    // The default agent, as the server resolves it: today's pipeline, one entry per stage. The
    // blocks name no model, so the project's policy is still what these tests are reading.
    agent: {
      agentId: "a1",
      name: "Default",
      sequence: [
        { key: "implement", kind: "step", name: "Implement", prompt: "make the change", capability: "edit" },
        { key: "protected-paths", kind: "gate", name: "Protected files", gateKind: "protected-paths" },
        { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" },
        { key: "test-presence", kind: "gate", name: "Test written", gateKind: "test-presence" },
        { key: "build", kind: "gate", name: "Builds", gateKind: "build" },
        { key: "test-run", kind: "gate", name: "Tests pass", gateKind: "test-run" },
        { key: "review", kind: "gate", name: "Reviewed", gateKind: "review" },
        { key: "push", kind: "step", name: "Push", deterministic: true },
        { key: "pull-request", kind: "step", name: "Pull request", deterministic: true },
      ],
    },
  };

  // The task the worker moves on to, so a refusal that settles late has a live run to endanger
  const NEXT_TASK: ClaimedTask = { ...CLAIMED, taskId: "t2", taskKey: "CP-10", taskNumber: 10 };

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

  function streamingRunner(
    claudeCalls: string[][] = [],
    onAgentStart?: (nth: number) => void,
    everyCall: string[][] = []
  ): Runner {
    return {
      async run(command, args, opts) {
        everyCall.push([command, ...args]);
        if (command === "claude") {
          claudeCalls.push(args);
          onAgentStart?.(claudeCalls.length);
          for (const part of pipeFlushes(AGENT_STREAM)) {
            opts.onStdout?.(part);
            await new Promise((resolve) => setImmediate(resolve));
          }
          return { code: 0, stdout: AGENT_STREAM, stderr: "", timedOut: false };
        }
        // The base is resolved off the wire now, so ls-remote has to answer with the ref it was
        // asked for; whether the *right* ref is picked out is gate-integrity's subject, on real git
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: `${REPO}\t${args[args.length - 1]}\n`, stderr: "", timedOut: false };
        }
        // bindRepository insists the path is its own toplevel; every other git call is content-free
        return {
          code: 0,
          stdout: args.includes("rev-parse") ? REPO : args.includes("get-url") ? REMOTE : "",
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
    postEvent: ApiClient["postEvent"] = async () => ({ applied: true }),
    policy?: Record<string, unknown>,
    opts: {
      assignmentRemote?: string;
      extraAssignmentFields?: Record<string, unknown>;
      readFile?: (path: string) => string | null;
      // Written into the run's own state directory before the worker starts, the way an operator's
      // choices already sit there — repos.json, worker.json, and now the pinned GitHub account
      stateFiles?: Record<string, string>;
      // Claimed in order, one per pass of the loop, then the queue runs dry
      tasks?: ClaimedTask[];
      onAgentStart?: (nth: number) => void;
    } = {}
  ) {
    let seenHeartbeat: HeartbeatDeps | undefined;
    const stateDir = mkdtempSync(join(tmpdir(), "cp-wiring-run-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });

    for (const [name, contents] of Object.entries(opts.stateFiles ?? {})) {
      writeFileSync(join(stateDir, name), contents, { mode: 0o600 });
    }

    const telemetry = createTelemetry();
    const posted: PhaseEvent[] = [];
    const claudeCalls: string[][] = [];
    const everyCall: string[][] = [];
    const bindingErrors: string[] = [];
    const queue = opts.tasks ?? [CLAIMED];
    const logError = vi.fn();
    let claims = 0;
    let localConfig: (() => LocalConfigView) | undefined;

    const api = {
      claim: vi.fn<ApiClient["claim"]>(async () => queue[claims++] ?? null),
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
      runner: streamingRunner(claudeCalls, opts.onAgentStart, everyCall),
      hostname: () => "host-1",
      // the loop only sleeps once it has nothing left to claim, which is one pass after the run
      sleep: async () => stop(),
      log: vi.fn(),
      logError,
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          // What this machine could set up but has not — read only by the socket, never by the
          // claim loop
          offers: [
            {
              project: "p2",
              key: "SB",
              name: "Sandbox",
              repositoryUrl: "https://github.com/owner/sandbox",
            },
          ],
          // Work policy travels with the assignment now: it describes the project, so two projects
          // on one machine can resolve differently.
          assignments: [
            {
              project: "p1",
              remote: opts.assignmentRemote ?? REMOTE,
              ...(opts.extraAssignmentFields ?? {}),
              ...(policy ? { policy } : {}),
            },
          ],
        }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () => api as unknown as ApiClient,
      createTelemetry: () => telemetry,
      // A checkout with what the gates need, unless a test says otherwise. Left to the real
      // filesystem this described a repository with no lockfile and no scripts — which since
      // BP-379 is one the worker declines to claim from, so every run test would be asserting
      // against a machine that correctly refuses to work.
      readFile:
        opts.readFile ??
        ((path: string) =>
          path.endsWith("package-lock.json")
            ? "{}"
            : path.endsWith("package.json")
              ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
              // Everything else still comes off the real filesystem, which is how the state
              // directory written by `stateFiles` reaches the worker.
              : existsSync(path)
                ? readFileSync(path, "utf8")
                : null),
      startHeartbeat: (heartbeatDeps) => {
        seenHeartbeat = heartbeatDeps;
        return fakeHeartbeat(bindingErrors);
      },
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: (localDeps) => {
        localConfig = localDeps.config;
        return { ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };
      },
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
      bindingErrors,
      logError,
      claimed: claudeCalls.length > 0,
      everyCall,
      workspacePaths: claudeCalls.flat(),
      phases: posted.map((event) => event.phase),
      telemetry,
      worker,
      claudeArgs: claudeCalls[0] ?? [],
      localConfig,
      heartbeatDeps: seenHeartbeat,
    };
  }

  // Children run in their own session since the process-group change, so a terminal Ctrl-C reaches
  // only the worker. loop.stop() alone is a flag checked between tasks, which would mean waiting out
  // a run that can last the full task timeout with the agent still working.
  it("aborts the run in flight when the worker is asked to shut down", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cp-shutdown-"));
    writeFileSync(join(stateDir, "repos.json"), JSON.stringify({ repos: [REPO] }), { mode: 0o600 });
    let sawAbort = false;
    let claims = 0;
    let reachedSleep = false;
    let shutdown = () => {};

    const hangingRunner: Runner = {
      async run(command, args, opts) {
        if (command === "claude") {
          shutdown();
          // shutdown aborts synchronously, so the signal is already aborted by the time we look —
          // registering a listener first and only then calling shutdown would wait forever
          if (!opts.signal?.aborted) {
            await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
          }
          sawAbort = opts.signal?.aborted === true;
          return { code: 143, stdout: "", stderr: "aborted", timedOut: false };
        }
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: `${REPO}\t${args[args.length - 1]}\n`, stderr: "", timedOut: false };
        }
        return { code: 0, stdout: args.includes("rev-parse") ? REPO : args.includes("get-url") ? REMOTE : "", stderr: "", timedOut: false };
      },
    };

    const worker = createWorker({
      env: { ...ENV, CP_STATE_DIR: stateDir },
      runner: hangingRunner,
      hostname: () => "host-1",
      // reaching this at all means the abort did not end the run — without it the loop spins with
      // nothing to claim and never yields, which starves even the test timeout
      sleep: async () => {
        reachedSleep = true;
        worker.shutdown();
      },
      log: vi.fn(),
      logError: vi.fn(),
      uid: 501,
      realpath: (path) => path,
      stat: () => ({ uid: 501, mode: 0o40700 }),
      // A checkout the gates would accept: since BP-379 the loop declines to claim from one that
      // fails checkRepo, and this test is about aborting a run, not about refusing to start one.
      readFile: (path: string) =>
        path.endsWith("package-lock.json")
          ? "{}"
          : path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : null,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ assignments: [{ project: "p1", remote: REMOTE }] }),
      }) as unknown as typeof fetch,
      createStore: (path) => memoryStore(path.endsWith("worker.json") ? IDENTITY : ""),
      createApi: () =>
        ({
          claim: vi.fn(async () => (claims++ === 0 ? CLAIMED : null)),
          setStatus: vi.fn().mockResolvedValue(undefined),
          comment: vi.fn().mockResolvedValue(undefined),
          release: vi.fn().mockResolvedValue(undefined),
          statusIds: vi.fn().mockResolvedValue({ approved: "todo", review: "in_review", done: "done" }),
          columnIds: vi.fn().mockResolvedValue(["todo", "in_progress", "in_review", "done"]),
          postEvent: async () => ({ applied: true }),
        }) as unknown as ApiClient,
      startHeartbeat: () => fakeHeartbeat(),
      connectControl: () => ({ close: vi.fn() }),
      startLocalServer: () => ({ ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) }),
    });
    shutdown = () => worker.shutdown();

    try {
      await worker.run();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }

    expect(sawAbort).toBe(true);
    expect(reachedSleep).toBe(false);
  });

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
      // the block the run is on, then the three events its own agent produced under it
      "step:implement",
      "agent",
      "agent",
      // protected-paths first: it is what decides whether the agent was allowed to write the files
      // the build and test gates would go on to execute
      "gates:protected-paths",
      "gates:diff-size",
      "gates:test-presence",
    ]);
  });

  // An outcome is durable and reaches the board through reporter.ts and its outbox. Letting one
  // onto this feed posts `phase: undefined` against a live run — the shape the phase field is
  // matched on — and spends the single in-flight slot the next real phase needs.
  it("keeps outcomes off the server's phase feed, which carries stages only", async () => {
    const { posted } = await runOneTask();

    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((event) => typeof event.phase === "string" && event.phase !== "")).toBe(true);
    expect(posted.map((event) => event.phase)).not.toContain(undefined);
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
    const { claudeArgs } = await runOneTask(undefined, {
      model: "haiku",
      fallbackModel: "opus",
    });

    expect(claudeArgs[claudeArgs.indexOf("--model") + 1]).toBe("haiku");
    expect(claudeArgs[claudeArgs.indexOf("--fallback-model") + 1]).toBe("opus");
  });

  // BP-373. `gh auth switch` is global machine state any terminal can flip, so the identity a run
  // pushes as has to be resolved by name at the start of that run rather than left to whichever
  // account gh happens to have active when delivery reaches the remote.
  it("resolves the pinned github account's token by name before the run", async () => {
    const { everyCall } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "rafalpodles" }) },
    });

    expect(everyCall).toContainEqual([
      expect.stringContaining("gh"),
      "auth",
      "token",
      "--user",
      "rafalpodles",
    ]);
  });

  // Opt-in. Asking gh for "the token" with nothing pinned would hand back the active account's,
  // which is the very thing being pinned away from.
  it("asks gh for no token at all when no account is pinned", async () => {
    const { everyCall } = await runOneTask();

    expect(everyCall.filter((call) => call.includes("token"))).toEqual([]);
  });

  // A pin the keyring cannot answer for must not take the run down with it: delivery falls back to
  // gh's own resolution, and the reason is on the operator's log rather than inside a 403 later.
  it("says so and carries on when the pinned account has no token to give", async () => {
    const { logError } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "logged-out-account" }) },
    });

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("logged-out-account")
    );
  });

  // Same join as the model test below, one surface further on: the server's policy has to reach the
  // socket the operator's own cockpit reads, or the app shows defaults while the run uses something
  // else. config knows the policy and local-server serves it; nothing carried one to the other.
  // Reporting one "model" would show an operator a value no run is using once two projects on one
  // machine resolve differently, so the socket reports each bound project instead.
  it("serves each project's own resolved policy on the socket, not the startup defaults", async () => {
    const { localConfig } = await runOneTask(undefined, {
      model: "haiku",
      reviewModel: "opus",
      maxDiffLines: 77,
    });

    expect(localConfig?.()).toMatchObject({
      apiUrl: "https://app.example.com",
      workerName: "worker-1",
      projectCount: 1,
      // Asserted against the producer, not only against a fixture: local-server serves this object
      // untransformed, so nothing else would notice the field being dropped or renamed here
      pollIntervalMs: 30_000,
    });
    expect(localConfig?.().projects).toEqual([
      expect.objectContaining({
        project: "p1",
        model: "haiku",
        reviewModel: "opus",
        maxDiffLines: 77,
      }),
    ]);
  });

  // BP-375. The app can only offer to set up a project it has heard of, and assignments carry only
  // the ones already working — so the socket has to carry the other half.
  it("serves the projects it could set up but has no checkout of", async () => {
    const { localConfig } = await runOneTask();

    expect(localConfig?.().offers).toEqual([
      {
        project: "p2",
        key: "SB",
        name: "Sandbox",
        repositoryUrl: "https://github.com/owner/sandbox",
      },
    ]);
  });

  // The cockpit's Connection tab answers "which account did that push act as" from this, so it has
  // to be the live pin rather than the value preflight read when the process started.
  it("serves the pinned github account on the socket, and never a token", async () => {
    const { localConfig } = await runOneTask(undefined, undefined, {
      stateFiles: { "github.json": JSON.stringify({ account: "rafalpodles" }) },
    });

    const view = localConfig?.();
    expect(view?.githubAccount).toBe("rafalpodles");
    expect(JSON.stringify(view)).not.toMatch(/gho_|ghp_|cpw_/);
  });

  it("puts no credential and no repository path on the socket", async () => {
    const { localConfig } = await runOneTask();

    expect(JSON.stringify(localConfig?.())).not.toMatch(/cp_admin_token|cpw_|\/repos\/demo/);
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

  // A task can be taken from a running worker: changeStatus refuses while a run holds it, but a
  // person can override with force, and the server then clears the run from the task. Every phase
  // post after that comes back applied:false — the only sign the worker gets that the rest of this
  // run is tokens spent on work whose result will be refused.
  describe("a task taken from the run that holds it", () => {
    it("stops the run when the server says it no longer holds the task", async () => {
      const run = await runOneTask(async (event) => ({ applied: event.phase !== "agent" }));

      // released, not gate-rejected: the run ended where the refusal arrived
      expect(run.api.release).toHaveBeenCalledWith("p1", "t1");
      expect(run.api.setStatus).not.toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.phases.some((phase) => phase.startsWith("gates:"))).toBe(false);
      // said once, not once per phase still in flight while the run unwinds
      const lost = run.logError.mock.calls.filter(([message]) =>
        message.includes("no longer has run")
      );
      expect(lost).toHaveLength(1);
    });

    // The server answers applied:false for an overtaken event too, and a post that settles after
    // its own run has ended is indistinguishable from one. Ending the run in flight on it would
    // kill the next task's run — real work, for a refusal that concerns the previous one.
    it("leaves the run in flight alone when the refusal belongs to the run before it", async () => {
      let deliverLate = (): void => {};
      const late = new Promise<{ applied: boolean }>((resolve) => {
        deliverLate = () => resolve({ applied: false });
      });

      const run = await runOneTask(
        async (event) =>
          event.taskId === "t1" && event.phase === "agent" ? late : { applied: true },
        undefined,
        {
          tasks: [CLAIMED, NEXT_TASK],
          // the first task's refusal lands while the second task's run is the one in flight
          onAgentStart: (nth) => {
            if (nth === 2) deliverLate();
          },
        }
      );

      expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t2", "in_review");
      expect(run.api.release).not.toHaveBeenCalled();
      expect(run.logError).not.toHaveBeenCalledWith(expect.stringContaining("no longer has run"));
    });

    it("aborts nothing when the refusal lands with no run in flight at all", async () => {
      let deliverLate = (): void => {};
      const late = new Promise<{ applied: boolean }>((resolve) => {
        deliverLate = () => resolve({ applied: false });
      });

      const run = await runOneTask(async (event) =>
        event.phase === "agent" ? late : { applied: true }
      );

      // the loop has stopped by now, so there is no run for a refusal to be about
      deliverLate();
      await new Promise((resolve) => setImmediate(resolve));

      expect(run.api.setStatus).toHaveBeenCalledWith("p1", "t1", "in_review");
      expect(run.logError).not.toHaveBeenCalledWith(expect.stringContaining("no longer has run"));
    });
  });

  // The invariant the whole change exists to protect, and the one that had no test: an assignment
  // naming a remote this machine does not have must bind nothing and say why.
  describe("the server can never name a directory here", () => {
    it("binds nothing and reports the reason when the remote is not on this machine", async () => {
      const run = await runOneTask(undefined, undefined, {
        assignmentRemote: "git@github.com:someone/else.git",
      });

      expect(run.claimed).toBe(false);
      expect(run.bindingErrors.join(" ")).toMatch(/no checkout of git@github\.com:someone\/else\.git/);
    });

    // The gates run `npm ci` and `npm run build` unconditionally, so a repository without a
    // lockfile or without those scripts fails every task forever. It can only be checked once a
    // repository is bound, so the report has to pick it up on rebind rather than at startup.
    it("adds the bound repository's own shortcomings to the report", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { test: "vitest" } }) : null,
      });

      const report = run.heartbeatDeps?.preflight?.();
      expect(report?.ok).toBe(false);
      expect(report?.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(
        expect.arrayContaining(["package-lock.json", "build script"])
      );
      expect(report?.checks.find((c) => c.name === "package-lock.json")?.detail).toContain(REPO);
    });

    // BP-379. Found by running it: MP-75 was claimed from a repository with no lockfile and no
    // test script, an agent worked for sixteen minutes, and the run died at a gate whose reason
    // checkRepo had already reported at binding time.
    it("does not claim from a repository its own checks already failed", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.claimed).toBe(false);
      expect(run.api.claim).not.toHaveBeenCalled();
    });

    it("says which project it is refusing, and why, rather than idling silently", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.logError).toHaveBeenCalledWith(
        expect.stringContaining("not claiming for project p1")
      );
      expect(run.logError).toHaveBeenCalledWith(expect.stringContaining("package-lock.json"));
    });

    // "Why is this machine sitting on a project and doing nothing" has to be answerable from the
    // cockpit, not only from a log line that scrolled past.
    it("says on the socket why the project is not being worked on", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json") ? JSON.stringify({ scripts: { lint: "eslint" } }) : null,
      });

      expect(run.localConfig?.().projects[0].blocked).toContain("package-lock.json");
    });

    it("claims as before from a repository that has what the gates need", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : "{}",
      });

      expect(run.claimed).toBe(true);
      expect(run.localConfig?.().projects[0].blocked).toBe("");
    });

    it("says nothing about a bound repository that has what the gates need", async () => {
      const run = await runOneTask(undefined, undefined, {
        readFile: (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
            : "{}",
      });

      const report = run.heartbeatDeps?.preflight?.();
      const repoNames = ["package-lock.json", "build script", "test script"];
      expect(report?.checks.filter((c) => repoNames.includes(c.name) && !c.ok)).toEqual([]);
    });

    // A server that sends a path alongside the remote must not get one used
    it("ignores a path the server sends alongside the remote", async () => {
      const run = await runOneTask(undefined, undefined, {
        extraAssignmentFields: { proposedPath: "/etc", path: "/etc" },
      });

      expect(run.workspacePaths.some((arg) => arg.startsWith("/etc"))).toBe(false);
    });
  });
});

// The check is only worth having if what it resolves actually reaches the child. Resolving
// `claude` through a login shell and then spawning a child whose PATH cannot see it is the exact
// failure mode this task exists to close: preflight green, every task failing.
describe("preflight's place in the wiring", () => {
  const RESOLVED = {
    git: "/opt/homebrew/bin/git",
    npm: "/opt/homebrew/bin/npm",
    claude: "/Users/me/.local/bin/claude",
    gh: "/opt/homebrew/bin/gh",
  };

  const PASSING: PreflightReport = {
    ok: true,
    account: "someone@example.com",
    checks: [{ name: "git", ok: true, detail: RESOLVED.git }],
    paths: RESOLVED,
    githubAccounts: [{ login: "octocat", active: true }],
    githubAccount: "octocat",
    githubPinned: false,
  };

  function preflightHarness(overrides: Partial<WorkerDeps> = {}) {
    const setPath = vi.fn();
    return {
      setPath,
      ...harness({
        env: { ...ENV, PATH: "/usr/bin:/bin" },
        runPreflight: vi.fn().mockResolvedValue(PASSING),
        setPath,
        ...overrides,
      }),
    };
  }

  it("puts the directories the tools were resolved in onto the PATH every child inherits", async () => {
    const { worker, setPath } = preflightHarness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(setPath).toHaveBeenCalledWith("/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
  });

  it("leaves the PATH alone when every tool is already reachable from it", async () => {
    const { worker, setPath } = preflightHarness({
      env: { ...ENV, PATH: "/opt/homebrew/bin:/Users/me/.local/bin" },
    });

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(setPath).not.toHaveBeenCalled();
  });

  it("reports nothing before preflight has run, rather than reporting a machine as broken", () => {
    const { seen } = preflightHarness();

    expect(seen.heartbeat?.preflight?.()).toBeUndefined();
  });

  it("reports the verdict and the claude account on the heartbeat", async () => {
    const { worker, seen } = preflightHarness();

    const running = worker.run();
    worker.shutdown();
    await running;

    expect(seen.heartbeat?.preflight?.()).toMatchObject({
      ok: true,
      account: "someone@example.com",
    });
  });

  it("keeps the worker running when preflight itself blows up", async () => {
    const { worker, logError, seen } = preflightHarness({
      runPreflight: vi.fn().mockRejectedValue(new Error("no shell on this machine")),
    });

    const running = worker.run();
    worker.shutdown();
    await expect(running).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(expect.stringContaining("preflight could not run"));
    expect(seen.heartbeat?.preflight?.()).toBeUndefined();
  });
});
