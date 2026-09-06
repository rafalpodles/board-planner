import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRASH_MARKER, guard, readBody } from "./stub-guard.mjs";

/**
 * The stubs are one process each for a whole Playwright run, so a throw inside a handler used to
 * end them and every spec after that point failed on a connection error (BP-575). What is asserted
 * here is the pair: the bad request is answered and reported, and the *next* request is still
 * served by the same process.
 */

let server: Server | undefined;
let errors: string[] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
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

  it("hands the body to the handler whole", async () => {
    let seen = "";
    const url = await listen(async (req, res) => {
      seen = await readBody(req as Parameters<typeof readBody>[0]);
      (res as { writeHead: (n: number) => { end: () => void } }).writeHead(204).end();
    });

    await fetch(url, { method: "POST", body: JSON.stringify({ messages: ["one", "two"] }) });
    expect(seen).toBe('{"messages":["one","two"]}');
  });

  it("leaves a throw after the reply started as a broken response rather than a plausible one", async () => {
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
