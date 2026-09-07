import { execFile, spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { AddressInfo, connect, createServer as createTcpServer } from "node:net";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRASH_MARKER, guard, readBody, serve } from "./stub-guard.mjs";

/**
 * The stubs are one process each for a whole Playwright run, so a throw inside a handler used to
 * end them and every spec after that point failed on a connection error (BP-575). What is asserted
 * here is the pair: the bad request is answered and reported, and the *next* request is still
 * served by the same process.
 *
 * The process-level half — `keepAlive` and a fatal bind failure — is asserted in a child process,
 * because there is no way to watch this one exit or survive from inside it.
 */

const run = promisify(execFile);

// The guard writes to fd 2 through `fs.writeSync` rather than console.error — see the comment on
// `report` — so that is the call these tests read. A module mock rather than a spy: an ESM
// namespace object cannot be spied on.
const { errors, stderr } = vi.hoisted(() => ({
  errors: [] as string[],
  // How the mocked fd 2 behaves for the test in hand: `accept` bytes per call, and `throwsOnce` to
  // reproduce the EAGAIN a full non-blocking pipe really raises.
  stderr: { accept: Infinity, throwsOnce: false, throwsAfter: Infinity, calls: 0 },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mocked = {
    ...actual,
    writeSync: (fd: number, data: unknown, offset?: number, length?: number) => {
      if (fd !== 2) {
        return (actual.writeSync as (...args: unknown[]) => number)(fd, data, offset, length);
      }
      stderr.calls += 1;
      if (stderr.throwsOnce || stderr.calls > stderr.throwsAfter) {
        stderr.throwsOnce = false;
        throw Object.assign(new Error("resource temporarily unavailable, write"), { code: "EAGAIN" });
      }
      // The real call takes a Buffer with an offset; it returns BYTES, which is what the loop in
      // `emit` advances by, so the mock has to count them the same way.
      const slice = Buffer.isBuffer(data)
        ? data.subarray(offset ?? 0, (offset ?? 0) + (length ?? data.length - (offset ?? 0)))
        : Buffer.from(String(data), "utf8");
      const taken = Math.min(slice.length, stderr.accept);
      errors.push(slice.subarray(0, taken).toString("utf8"));
      return taken;
    },
  };
  return { ...mocked, default: mocked };
});

let server: Server | undefined;
let stderrListeners: unknown[] = [];

beforeEach(() => {
  // The fallback installs a no-op `error` listener on the real stderr of whatever process runs it,
  // and here that is the vitest worker, where it would outlive the test and swallow the next real
  // stderr error in it.
  stderrListeners = process.stderr.listeners("error");
  errors.length = 0;
  stderr.accept = Infinity;
  stderr.throwsOnce = false;
  stderr.throwsAfter = Infinity;
  stderr.calls = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Also on the way out: `res.on("error")` can report after a body has finished, and a leftover
  // line would satisfy the next test's `toContain`.
  errors.length = 0;
  for (const listener of process.stderr.listeners("error")) {
    if (!stderrListeners.includes(listener)) {
      process.stderr.removeListener("error", listener as () => void);
    }
  }
  const running = server;
  server = undefined;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

async function listen(handler: (req: unknown, res: unknown) => unknown): Promise<string> {
  const started = createServer(guard("test stub", handler));
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}

/** A port nothing is listening on any more, so the test can decide who holds it. */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Stands up a real `serve()` on a free port, runs `check` against it, and takes back the
 * `uncaughtException` listener it installed — left behind, that swallows the vitest worker's own
 * failures for the rest of the run.
 *
 * What it cannot take back is `keepAlive`'s module-level `guarding` flag, which has no reset. A
 * SECOND `serve()` in this worker would therefore install no listener at all, and a throw escaping
 * a handler there would take the rest of the file with it — this ticket's own bug, inside the
 * harness. One caller today; the next one needs `vi.resetModules()`.
 */
async function withServe(check: (url: string) => Promise<void>): Promise<void> {
  const before = process.listeners("uncaughtException");
  const port = await freePort();
  const started = serve({
    name: "served by serve",
    port,
    handler: (req: { url?: string }, res: { writeHead: (n: number) => { end: (b?: string) => void } }) => {
      if (req.url === "/health") {
        res.writeHead(200).end("ok");
        return;
      }
      throw new Error("the directive was not JSON");
    },
  }) as Server;

  try {
    await check(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => started.close(() => resolve()));
    for (const listener of process.listeners("uncaughtException")) {
      if (!before.includes(listener)) process.removeListener("uncaughtException", listener);
    }
  }
}

/** Runs a script against the real module, in its own process, and reports how it ended. */
async function child(source: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `import { keepAlive, serve } from "./e2e/stub-guard.mjs";\n${source}`;
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: process.cwd() }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("guard", () => {
  it("answers 500 and keeps serving after a handler throws", async () => {
    let calls = 0;
    const url = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) throw new Error("the directive was not JSON");
      (res as { writeHead: (n: number) => { end: (b: string) => void } }).writeHead(200).end("ok");
    });

    const crashed = await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "{{" });
    expect(crashed.status).toBe(500);

    // The whole point: the same process answers the request after the one that killed it before.
    const next = await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(next.status).toBe(200);
    expect(await next.text()).toBe("ok");
  });

  it("reports the offending request and the stack, so the crash is visible in the run output", async () => {
    const url = await listen(() => {
      throw new Error("the directive was not JSON");
    });
    await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "{{" });

    const reported = errors.join("\n");
    expect(reported).toContain(CRASH_MARKER);
    expect(reported).toContain("test stub");
    expect(reported).toContain("POST /v1/chat/completions");
    expect(reported).toContain("the directive was not JSON");
    // The stack, not only the message — the ticket's whole complaint is not knowing what threw.
    expect(reported).toMatch(/stub-guard\.test\.ts/);
  });

  it("catches a rejection from an async handler, which is where the body is parsed", async () => {
    const url = await listen(async (req) => {
      const raw = await readBody(req as Parameters<typeof readBody>[0]);
      JSON.parse(raw);
    });

    const crashed = await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "not json" });
    expect(crashed.status).toBe(500);
    expect(errors.join("\n")).toContain(CRASH_MARKER);
  });

  it("reports a throw that lands after the reply started, and leaves the reply unfinished", async () => {
    // What this cannot pin is destroy-versus-end: both reach the client as a socket error, since
    // the Content-Length promised above is never satisfied either way.
    const url = await listen((_req, res) => {
      const reply = res as { writeHead: (n: number, h: unknown) => void; write: (b: string) => void };
      reply.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
      reply.write('{"choices":');
      throw new Error("threw halfway through the answer");
    });

    await expect(fetch(`${url}/v1/chat/completions`)).rejects.toThrow();
    expect(errors.join("\n")).toContain("threw halfway through the answer");
  });
});

describe("reporting", () => {
  it("writes the whole report when stderr takes it a piece at a time", async () => {
    // `writeSync` does not loop: on a pipe it returns a short count at the 64 KB buffer and drops
    // the rest without a word, which is how the first cut of this could truncate a stack.
    stderr.accept = 8;
    const url = await listen(() => {
      throw new Error("a stack long enough to need more than one write");
    });
    await fetch(`${url}/v1/chat/completions`, { method: "POST" });

    expect(errors.length).toBeGreaterThan(1);
    expect(errors.join("")).toContain("a stack long enough to need more than one write");
    expect(errors.join("")).toContain(CRASH_MARKER);
  });

  it("gives up rather than spinning when stderr accepts nothing and reports no error", async () => {
    // `writeSync` returning 0 is not progress, and a loop that keeps asking wedges the event loop
    // — this function failing in the one way its whole point is to avoid.
    stderr.accept = 0;
    const url = await listen(() => {
      throw new Error("the directive was not JSON");
    });

    const crashed = await fetch(`${url}/v1/chat/completions`, { method: "POST" });
    expect(crashed.status).toBe(500);
    // Exactly one: `toBeLessThan` was also satisfied by a report that was never written at all.
    expect(errors.length).toBe(1);
  });

  it("survives stderr refusing the write, rather than dying inside its own report", async () => {
    // Once anything has touched process.stderr the fd is non-blocking, and a full pipe makes
    // writeSync throw EAGAIN. Thrown from `report` that is fatal in the worst place: `report` is
    // what the uncaughtException handler calls, and a throw in there ends the process (BP-575
    // round-two review).
    stderr.throwsOnce = true;
    const queued: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      queued.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const url = await listen(() => {
      throw new Error("the directive was not JSON");
    });

    const crashed = await fetch(`${url}/v1/chat/completions`, { method: "POST" });
    // Still answered, and this process is still running to assert it.
    expect(crashed.status).toBe(500);
    // And the report was not dropped on the way: what fd 2 refused went to the stream instead.
    expect(queued.join("")).toContain("the directive was not JSON");
  });

  it("writes what the synchronous call took, then queues only the rest", async () => {
    // The real sequence, which the two cases above only ever meet apart: a short write at the pipe
    // buffer, and EAGAIN on the very next call within the same report.
    stderr.accept = 12;
    stderr.throwsAfter = 1;
    const queued: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      queued.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const url = await listen(() => {
      throw new Error("a stack that outlasts the buffer");
    });
    await fetch(`${url}/v1/chat/completions`, { method: "POST" });

    expect(errors.join("")).toBe(`\n${CRASH_MARKER} [`.slice(0, 12));
    expect(queued.join("")).toContain("a stack that outlasts the buffer");
    // Nothing written twice: the queue picks up exactly where the synchronous write stopped. The
    // marker is inside the twelve bytes fd 2 already took, so re-queueing the whole report — which
    // a `subarray(0)` slip would do — puts it in here as well.
    expect(queued.join("")).not.toContain(CRASH_MARKER);
  });
});

describe("readBody", () => {
  it("hands the handler a body that arrived in one piece", async () => {
    let seen = "";
    const url = await listen(async (req, res) => {
      seen = await readBody(req as Parameters<typeof readBody>[0]);
      (res as { writeHead: (n: number) => { end: () => void } }).writeHead(204).end();
    });

    await fetch(url, { method: "POST", body: JSON.stringify({ messages: ["one", "two"] }) });
    expect(seen).toBe('{"messages":["one","two"]}');
  });

  it("joins chunks without corrupting a character split across two of them", async () => {
    // The PM chat box is typed into in Polish, and "ó" is two bytes. Decoding each chunk on its
    // own turns a split between those bytes into a pair of replacement characters, silently. The
    // request is written down the socket by hand, because a split at that exact byte cannot be
    // asked for through fetch.
    let seen = "";
    const url = await listen(async (req, res) => {
      seen = await readBody(req as Parameters<typeof readBody>[0]);
      (res as { writeHead: (n: number) => { end: () => void } }).writeHead(204).end();
    });
    const { port } = new URL(url);

    const body = Buffer.from("zrób to", "utf8");
    const split = body.indexOf(0xc3) + 1; // between the two bytes of "ó"
    expect(split).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n` +
            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`
        );
        socket.write(body.subarray(0, split));
        // A tick apart, so the server really reads two chunks rather than one coalesced write.
        setTimeout(() => socket.write(body.subarray(split)), 20);
      });
      socket.on("error", reject);
      socket.on("data", () => {
        socket.end();
        resolve();
      });
    });

    expect(seen).toBe("zrób to");
  });
});

describe("the process-level guard", () => {
  it("survives a throw from a timer, which no handler catch can reach", async () => {
    const ended = await child(`
      keepAlive("timer test");
      setTimeout(() => { throw new Error("thrown from a timer"); }, 10);
      setTimeout(() => { console.log("STILL ALIVE"); process.exit(0); }, 300);
    `);

    expect(ended.code).toBe(0);
    expect(ended.stdout).toContain("STILL ALIVE");
    expect(ended.stderr).toContain(CRASH_MARKER);
    expect(ended.stderr).toContain("thrown from a timer");
  }, 20_000);

  it("reports a server error after it is listening, and stays up", async () => {
    // The other half of the `listening` flag. An accept failure or EMFILE is not a reason to take
    // the stub down; making every server error fatal is the original bug wearing a new hat.
    const port = await freePort();
    const ended = await child(`
      const server = serve({ name: "late error", port: ${port}, handler: (_req, res) => res.writeHead(204).end() });
      server.on("listening", () => {
        server.emit("error", Object.assign(new Error("accept failed"), { code: "EMFILE" }));
        setTimeout(() => { console.log("STILL ALIVE"); process.exit(0); }, 100);
      });
    `);

    expect(ended.code).toBe(0);
    expect(ended.stdout).toContain("STILL ALIVE");
    expect(ended.stderr).toContain("accept failed");
  }, 20_000);

  it("survives a rejected promise nobody awaited, which arrives as an uncaught exception", async () => {
    const ended = await child(`
      keepAlive("rejection test");
      Promise.reject(new Error("nobody awaited this"));
      setTimeout(() => { console.log("STILL ALIVE"); process.exit(0); }, 300);
    `);

    expect(ended.code).toBe(0);
    expect(ended.stdout).toContain("STILL ALIVE");
    expect(ended.stderr).toContain(CRASH_MARKER);
    expect(ended.stderr).toContain("nobody awaited this");
  }, 20_000);

  it("does not spin when stderr itself is gone", async () => {
    // The livelock the fallback invited: fd 2 unwritable, so writeSync throws, the queued write
    // emits `error` on a stream nobody listens to, Node raises that as an uncaught exception, and
    // the handler reports again — 127,832 rounds in five seconds, measured, with the stub alive
    // and serving nothing (BP-575 round-three review).
    const rounds = await new Promise<number>((resolve, reject) => {
      const spawned = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { keepAlive } from "./e2e/stub-guard.mjs";
           keepAlive("livelock test");
           let seen = 0;
           process.on("uncaughtException", () => { seen += 1; });
           setTimeout(() => { throw new Error("the report has nowhere to go"); }, 20);
           setTimeout(() => { console.log("ROUNDS " + seen); process.exit(0); }, 600);`,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
      );
      // The reader goes away, which is what makes fd 2 refuse the write.
      spawned.stderr.destroy();
      let out = "";
      spawned.stdout.on("data", (chunk) => (out += chunk));
      spawned.on("error", reject);
      spawned.on("close", () => resolve(Number(/ROUNDS (\d+)/.exec(out)?.[1] ?? -1)));
    });

    // At least one: zero would mean the seeded throw never fired and the scenario never engaged.
    expect(rounds).toBeGreaterThanOrEqual(1);
    // One report, not a storm. The number is a ceiling with room, not a measurement.
    expect(rounds).toBeLessThan(20);
  }, 20_000);

  it("reports before it exits, when a stub refuses to start at all", async () => {
    const ended = await child(`
      import { fatal } from "./e2e/stub-guard.mjs";
      fatal("startup test", "E2E_MONGODB_URI must name a database");
    `);

    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain(CRASH_MARKER);
    expect(ended.stderr).toContain("E2E_MONGODB_URI must name a database");
  }, 20_000);

  it("still dies when it cannot bind, rather than holding a port it never serves", async () => {
    // The regression the guard invited: `uncaughtException` turns an EADDRINUSE that used to end
    // the process into a clean exit or a hang, and Playwright then waits out its own timeout
    // instead of reading the reason (BP-575 review).
    const port = await freePort();
    const holder = createTcpServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));

    try {
      const ended = await child(`
        serve({ name: "bind test", port: ${port}, handler: (_req, res) => res.writeHead(204).end() });
        setTimeout(() => { console.log("STILL ALIVE"); process.exit(0); }, 2000);
      `);

      expect(ended.code).toBe(1);
      expect(ended.stdout).not.toContain("STILL ALIVE");
      expect(ended.stderr).toContain(CRASH_MARKER);
      expect(ended.stderr).toContain("EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 20_000);
});

describe("serve", () => {
  it("wraps the handler it is given, so every stub built on it is guarded", () => {
    // The property the four stubs actually rest on, and the one a static scan of the files could
    // not see: un-guarding `serve` un-guards all of them at once, and a scan that reads their
    // source still finds `serve(` where it expects it.
    //
    // A scan is what stood here — comments and strings stripped, imports resolved, calls matched.
    // Six review rounds found five holes in it (a default import, an alias assignment, a handler
    // guarded into a const first) and it never could see this mutation at all. A test that drives
    // the thing is worth more than an analyser nobody maintains.
    return withServe(async (url) => {
      // Bounded: without the guard nothing answers this at all, and the failure should say the
      // request went unanswered rather than sit out the test's own timeout.
      const crashed = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(1_500),
      });
      expect(crashed.status).toBe(500);
      // The BODY, which only the guard writes. `keepAlive` reports the same marker to stderr from
      // the same name, so a stderr assertion alone cannot say which path answered.
      expect(await crashed.text()).toContain(CRASH_MARKER);
      expect(errors.join("")).toContain("served by serve");

      // And still serving, which is the whole of BP-575.
      const next = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_500) });
      expect(next.status).toBe(200);
    });
  });
});
