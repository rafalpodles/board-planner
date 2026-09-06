import { execFileSync } from "child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { request as httpRequest } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";
import { CommandChannels, createCommandHandlers } from "./commands.js";
import { LocalConfigView, LocalServer, startLocalServer } from "./local-server.js";
import { createLoop, Loop } from "./loop.js";
import { createTelemetry, Telemetry } from "./telemetry.js";

const started: LocalServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of started.splice(0)) await server.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-local-"));
  dirs.push(dir);
  return join(dir, "worker.sock");
}

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

// One populated project, not none: the disclosure test below reads this body, and a credential or a
// checkout path would leak from a *project* row. With projects empty there were no rows to inspect,
// so adding `checkout: repoPath` to the view left that test green.
const SOME_CONFIG: LocalConfigView = {
  apiUrl: "http://localhost:3000",
  workerName: "test-worker",
  projectCount: 1,
  pollIntervalMs: 30_000,
  githubAccount: "octocat",
  githubAccounts: [{ login: "octocat", active: true }],
  offers: [],
  catalogue: [],
  projects: [
    {
      project: "p1",
      blocked: "",
      baseBranch: "main",
      model: "opus",
      reviewModel: "opus",
      maxDiffLines: 800,
      taskTimeoutMs: 1000,
    },
  ],
};

async function serve(
  opts: {
    handlers?: CommandChannels;
    // /status reads current() too, so a stub standing in for the real telemetry has to have it
    telemetry?: Pick<Telemetry, "subscribe" | "recent" | "current">;
    socketPath?: string;
    config?: () => LocalConfigView;
  } = {}
) {
  const loop = idleLoop();
  const abort = vi.fn();
  const ack = vi.fn();
  const channels = opts.handlers ?? createCommandHandlers({ loop, runs: { abort }, ack });
  const socketPath = opts.socketPath ?? tempSocketPath();

  const server = startLocalServer({
    socketPath,
    handlers: channels.local,
    telemetry: opts.telemetry ?? createTelemetry(),
    paused: () => loop.paused(),
    config: opts.config ?? (() => SOME_CONFIG),
    log: vi.fn(),
  });
  started.push(server);
  await server.ready;

  return { loop, abort, ack, channels, socketPath, server };
}

function call(
  socketPath: string,
  method: string,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function openStream(socketPath: string): Promise<{ frames: string[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "GET", path: "/stream" }, (response) => {
      const frames: string[] = [];
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => frames.push(chunk));
      resolve({ frames, close: () => request.destroy() });
    });
    request.on("error", reject);
    request.end();
  });
}

// A worker killed with SIGKILL never unlinks; the inode it bound stays on disk and the next bind()
// at that path fails with EADDRINUSE. process.exit() from the listen callback reproduces exactly
// that, since it skips the close path that would otherwise remove the file.
function leaveStaleSocket(socketPath: string): void {
  execFileSync(process.execPath, [
    "-e",
    "require('net').createServer().listen(process.argv[1], () => process.exit(0))",
    socketPath,
  ]);
}

describe("the local socket as a transport", () => {
  it("binds a socket no other user on the machine can open", async () => {
    const { socketPath } = await serve();

    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("replaces the socket a killed worker left behind instead of refusing to bind", async () => {
    const socketPath = tempSocketPath();
    leaveStaleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    await serve({ socketPath });

    expect((await call(socketPath, "GET", "/status")).status).toBe(200);
  });

  it("refuses to delete something at the socket path that is not a socket", async () => {
    const socketPath = tempSocketPath();
    writeFileSync(socketPath, "not a socket");

    const server = startLocalServer({
      socketPath,
      handlers: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
      telemetry: createTelemetry(),
      paused: () => false,
      config: () => SOME_CONFIG,
      log: vi.fn(),
    });
    started.push(server);

    await expect(server.ready).rejects.toThrow(/refusing to remove it/);
    expect(readFileSync(socketPath, "utf8")).toBe("not a socket");
  });

  it("takes the socket off disk when it closes", async () => {
    const { socketPath, server } = await serve();

    await server.close();

    expect(existsSync(socketPath)).toBe(false);
    await expect(call(socketPath, "GET", "/status")).rejects.toThrow();
  });
});

describe("the route list", () => {
  it("404s everything outside it, including the log route the worker cannot serve", async () => {
    const { socketPath } = await serve();

    // No log route: the worker writes to console.error and thence to launchd, and has no file to
    // hand over. A route it has no source for would have to invent one.
    expect((await call(socketPath, "GET", "/logs")).status).toBe(404);
    expect((await call(socketPath, "GET", "/")).status).toBe(404);
    expect((await call(socketPath, "GET", "/../status")).status).toBe(404);
  });

  it("404s a known path reached with the wrong method", async () => {
    const { socketPath } = await serve();

    expect((await call(socketPath, "POST", "/status")).status).toBe(404);
    expect((await call(socketPath, "GET", "/pause")).status).toBe(404);
  });

  it("reports what the run is doing on /status", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });
    telemetry.emit({ phase: "worktree" });
    telemetry.emit({ phase: "agent", tool: { name: "Edit", target: "src/foo.ts" } });

    const { status, body } = await call(socketPath, "GET", "/status");

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      paused: false,
      current: { phase: "agent", tool: { name: "Edit", target: "src/foo.ts" } },
      recent: [{ phase: "worktree" }, { phase: "agent", tool: { name: "Edit", target: "src/foo.ts" } }],
    });
  });
});

describe("commands over the socket", () => {
  it("pauses through the command handlers, so the acknowledgement still goes out", async () => {
    const { socketPath, loop, ack } = await serve();

    const { status, body } = await call(socketPath, "POST", "/pause");

    expect(loop.paused()).toBe(true);
    expect(ack).toHaveBeenCalledWith("pause");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ paused: true });
  });

  it("stops by aborting the run and pausing, never by stopping the loop", async () => {
    const loop = idleLoop();
    const stop = vi.spyOn(loop, "stop");
    const abort = vi.fn();
    const handlers = createCommandHandlers({ loop, runs: { abort }, ack: vi.fn() });
    const { socketPath } = await serve({ handlers });

    await call(socketPath, "POST", "/stop");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(loop.paused()).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  // The guard commands.ts owns orders by issuance, so a local command has to carry one — an undated
  // command would leave lastAppliedAt untouched and let a superseded server command back in.
  // The board's stop is the emergency brake. It is stamped by the server's clock, so a local pause
  // that entered the same guard would let a laptop running fast discard it — and the run would
  // carry on to merge while the operator was told it had stopped.
  it("never lets a local command discard a later stop issued by the board", async () => {
    const { socketPath, loop, abort, channels } = await serve();

    await call(socketPath, "POST", "/pause");
    channels.remote.stop(new Date(4_000).toISOString());

    expect(abort).toHaveBeenCalledTimes(1);
    expect(loop.paused()).toBe(true);
  });

  it("leaves the server's ordering untouched, so its own commands still order among themselves", async () => {
    const { socketPath, loop, channels } = await serve();

    await call(socketPath, "POST", "/pause");
    channels.remote.resume(new Date(9_000).toISOString());
    channels.remote.pause(new Date(8_000).toISOString());

    expect(loop.paused()).toBe(false);
  });

  it("does not let two commands issued in the same millisecond collapse into one", async () => {
    const { socketPath, loop } = await serve();

    await call(socketPath, "POST", "/pause");
    expect(loop.paused()).toBe(true);
    const { body } = await call(socketPath, "POST", "/resume");

    expect(loop.paused()).toBe(false);
    expect(JSON.parse(body)).toEqual({ paused: false });
  });
});

describe("the progress stream", () => {
  it("delivers progress to a connected client as it happens", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });
    const stream = await openStream(socketPath);

    telemetry.emit({ phase: "gates:build" });

    await vi.waitFor(() => expect(stream.frames.join("")).toContain('data: {"phase":"gates:build"}\n\n'));
    stream.close();
  });

  // wiring.ts awaits close() during shutdown, and closing a server only stops it accepting new
  // connections — an attached menubar would otherwise hold the process open until launchd escalates
  // to SIGKILL. The client here deliberately never disconnects.
  it("closes down promptly with a client still attached", async () => {
    const { socketPath, server } = await serve();
    await openStream(socketPath);

    await expect(
      Promise.race([
        server.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close() hung")), 1_000)),
      ])
    ).resolves.toBeUndefined();
  });

  // Reversed in part C, deliberately. The stream used to drop quota, which left the operator with
  // no local source for the one notification that explains why a run stopped. /status still replays
  // progress only — the ring is what stays progress-shaped, not the stream.
  it("puts quota on the stream, so a client can say why the run stopped", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });
    const stream = await openStream(socketPath);

    telemetry.emit({ status: "rejected", utilization: 100 });

    await vi.waitFor(() => expect(stream.frames.join("")).toContain('"status":"rejected"'));
    stream.close();
  });

  it("puts an outcome on the stream, which is where a notification comes from", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });
    const stream = await openStream(socketPath);

    telemetry.emit({ outcome: "merged", taskKey: "CP-1" });

    await vi.waitFor(() =>
      expect(stream.frames.join("")).toContain('data: {"outcome":"merged","taskKey":"CP-1"}\n\n')
    );
    stream.close();
  });

  it("keeps quota and outcomes out of the /status replay, which is progress only", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });

    telemetry.emit({ status: "allowed_warning", utilization: 76 });
    telemetry.emit({ outcome: "merged", taskKey: "CP-1" });
    telemetry.emit({ phase: "push" });

    const body = JSON.parse((await call(socketPath, "GET", "/status")).body);
    expect(body.recent).toEqual([{ phase: "push" }]);
  });

  // The live rig showed a worker reporting current: {phase: "push"} six hours after its run ended,
  // because /status served the last phase ever emitted. A client reading that shows "working" for
  // as long as the worker stays up.
  it("stops reporting a current phase once the run has settled", async () => {
    const telemetry = createTelemetry();
    const { socketPath } = await serve({ telemetry });
    telemetry.emit({ phase: "push", taskKey: "CP-1" });
    telemetry.emit({ outcome: "merged", taskKey: "CP-1" });

    const body = JSON.parse((await call(socketPath, "GET", "/status")).body);

    expect(body.current).toBeNull();
    expect(body.recent).toEqual([{ phase: "push", taskKey: "CP-1" }]);
  });

  it("serves the effective config the worker is actually running under", async () => {
    // The shape wiring.ts really serves: the per-run settings live under each project, because a
    // worker binds several and they do not share a model. Asserted here in that shape after this
    // test spent its life checking that a top-level `model` — which nothing ever produces — came
    // back out of the object it had just put in (BP-334).
    const { socketPath } = await serve({
      config: () => ({
        apiUrl: "http://localhost:3991",
        workerName: "rig-laptop",
        projectCount: 1,
        pollIntervalMs: 30_000,
        githubAccount: "owner",
        githubAccounts: [{ login: "owner", active: true }],
        offers: [],
        catalogue: [],
        projects: [
          {
            project: "BP",
            blocked: "",
            baseBranch: "main",
            model: "opus",
            reviewModel: "sonnet",
            maxDiffLines: 400,
            taskTimeoutMs: 900_000,
          },
        ],
      }),
    });

    const response = await call(socketPath, "GET", "/config");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      apiUrl: "http://localhost:3991",
      workerName: "rig-laptop",
      projectCount: 1,
      pollIntervalMs: 30_000,
      githubAccount: "owner",
      githubAccounts: [{ login: "owner", active: true }],
      offers: [],
      catalogue: [],
      projects: [
        {
          project: "BP",
          blocked: "",
          baseBranch: "main",
          model: "opus",
          reviewModel: "sonnet",
          maxDiffLines: 400,
          taskTimeoutMs: 900_000,
        },
      ],
    });
  });

  // No route on this socket may disclose a credential or a repository binding — the agent runs at
  // this same uid and can reach it. See the header comment on local-server.ts.
  it("discloses no credential and no repository path", async () => {
    const { socketPath } = await serve();

    const body = (await call(socketPath, "GET", "/config")).body;

    expect(body).not.toMatch(/cpw_|token|credential|repoPath|worktreeRoot/i);
  });

  // Policy arrives from the server over SSE and changes under a running worker; a value captured at
  // startup would go stale the first time an operator edits it in the console.
  it("reads the config afresh on every request", async () => {
    let model = "opus";
    const { socketPath } = await serve({
      config: () => ({
        apiUrl: "http://x",
        workerName: "w",
        projectCount: 1,
        pollIntervalMs: 30_000,
        githubAccount: "owner",
        githubAccounts: [{ login: "owner", active: true }],
        offers: [],
        catalogue: [],
        projects: [
          {
            project: "BP",
            blocked: "",
            baseBranch: "main",
            model,
            reviewModel: "sonnet",
            maxDiffLines: 400,
            taskTimeoutMs: 1,
          },
        ],
      }),
    });

    const modelNow = async () =>
      JSON.parse((await call(socketPath, "GET", "/config")).body).projects[0].model;

    expect(await modelNow()).toBe("opus");
    model = "haiku";
    expect(await modelNow()).toBe("haiku");
  });

  it("lets go of its subscription when the client disconnects", async () => {
    const telemetry = createTelemetry();
    let live = 0;
    const { socketPath } = await serve({
      telemetry: {
        recent: telemetry.recent,
        // Passed through: this test counts subscriptions, and wrapping only subscribe would leave
        // /status unable to answer while the stream is open
        current: telemetry.current,
        subscribe: (listener) => {
          live += 1;
          const unsubscribe = telemetry.subscribe(listener);
          return () => {
            live -= 1;
            unsubscribe();
          };
        },
      },
    });

    const stream = await openStream(socketPath);
    await vi.waitFor(() => expect(live).toBe(1));
    stream.close();

    await vi.waitFor(() => expect(live).toBe(0));
  });
});
