import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepRoutes, resurrectLostRoutes, urlOfRoute } from "./dev-routes";

let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dev-routes-"));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

function route(...segments: string[]) {
  const folder = join(dir, ...segments);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "route.ts"), "");
  return join(folder, "route.ts");
}

async function serve(answer: (url: string) => { status: number; type: string }) {
  server = createServer((request, response) => {
    const { status, type } = answer(request.url ?? "");
    response.writeHead(status, { "content-type": type });
    response.end(type === "application/json" ? "{}" : "<html>404</html>");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("which routes are looked at", () => {
  it("turns a route's directories into a URL with a value for every parameter", () => {
    expect(urlOfRoute(["api", "workers", "device", "[userCode]", "approve"])).toBe("/api/workers/device/x/approve");
    expect(urlOfRoute(["api", "task-leaf", "comment", "[...ids]"])).toBe("/api/task-leaf/comment/x/y");
  });

  it("keeps the routes of six segments or more and leaves the shallower ones", () => {
    route("a", "b", "c", "d", "e");
    const deep = route("a", "b", "c", "d", "e", "f");

    expect(deepRoutes(dir)).toEqual([{ file: deep, url: "/a/b/c/d/e/f" }]);
  });

  it("finds the approve route of device enrolment in the real app, the one BP-1061 lost", () => {
    const urls = deepRoutes(join(__dirname, "..", "src", "app")).map((found) => found.url);

    expect(urls).toContain("/api/workers/enrolment/device/x/approve");
  });
});

describe("a dev server that lost a route", () => {
  it("is nudged by touching the file until it finds the route again", async () => {
    const file = route("a", "b", "c", "d", "e", "f");
    const before = statSync(file).mtimeMs;
    const origin = await serve(() =>
      statSync(file).mtimeMs > before ? { status: 204, type: "text/plain" } : { status: 404, type: "text/html" }
    );

    const revived = await resurrectLostRoutes(origin, dir, { settleMs: 1 });

    expect(revived).toEqual(["/a/b/c/d/e/f"]);
    expect(statSync(file).mtimeMs).toBeGreaterThan(before);
  });

  it("is left alone when every route answers", async () => {
    const file = route("a", "b", "c", "d", "e", "f");
    const before = statSync(file).mtimeMs;
    const origin = await serve(() => ({ status: 204, type: "text/plain" }));

    expect(await resurrectLostRoutes(origin, dir, { settleMs: 1 })).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("does not take a handler's own JSON 404 for a lost route", async () => {
    const file = route("a", "b", "c", "d", "e", "f");
    const before = statSync(file).mtimeMs;
    const origin = await serve(() => ({ status: 404, type: "application/json" }));

    expect(await resurrectLostRoutes(origin, dir, { settleMs: 1 })).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("fails naming the routes when touching does not bring them back", async () => {
    route("a", "b", "c", "d", "e", "f");
    const origin = await serve(() => ({ status: 404, type: "text/html" }));

    await expect(resurrectLostRoutes(origin, dir, { attempts: 2, settleMs: 1 })).rejects.toThrow("/a/b/c/d/e/f");
  });
});

describe("a dev server that does not answer", () => {
  it("fails naming the route instead of waiting on it", async () => {
    route("a", "b", "c", "d", "e", "f");
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));

    await expect(resurrectLostRoutes(deadOrigin, dir, { settleMs: 1 })).rejects.toThrow(`OPTIONS ${deadOrigin}/a/b/c/d/e/f did not answer`);
  });
});
