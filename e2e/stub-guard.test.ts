import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { AddressInfo, connect, createServer as createTcpServer } from "node:net";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRASH_MARKER, guard, readBody } from "./stub-guard.mjs";

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
const { errors } = vi.hoisted(() => ({ errors: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeSync: (fd: number, text: unknown, ...rest: unknown[]) => {
      if (fd !== 2) return (actual.writeSync as (...args: unknown[]) => number)(fd, text, ...rest);
      errors.push(String(text));
      return String(text).length;
    },
  };
});

let server: Server | undefined;

beforeEach(() => {
  errors.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("every stub process", () => {
  it("reaches the guard, so a new one cannot quietly reintroduce the bug", async () => {
    // The ticket asks for the guard on every stub, not only the model one, and four of the five
    // were the same shape with the same gap. Nothing but this stops the sixth being written the
    // old way against a green suite.
    const unguarded = readdirSync("e2e")
      .filter((file) => file.endsWith(".mjs") && file !== "stub-guard.mjs")
      .filter((file) => {
        const source = readFileSync(`e2e/${file}`, "utf8");
        return /from "node:http"/.test(source) && !/from "\.\/stub-guard\.mjs"/.test(source);
      });

    expect(unguarded).toEqual([]);
  });
});
