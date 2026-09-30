import { test, expect } from "@playwright/test";
import http from "node:http";
import { seed, PROJECT_KEY, SIBLING_TASK_ID, SIBLING_TASK_NUMBER } from "./seed";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import { BASE_URL } from "../playwright.config";
import { TASK_DESCRIPTION_MAX_LENGTH } from "../src/lib/identifiers";
import { MAX_JSON_BODY_BYTES } from "../src/lib/request-body";

/**
 * BP-802. Every request context in this process shares one keep-alive agent, so a request can go
 * out on a socket an earlier test left idle. A server that closes idle sockets does it at a moment
 * the agent cannot see coming, and the request that picked that socket dies with ECONNRESET.
 */

test.beforeEach(async () => {
  await seed();
});

type Sent = { status: number; reused: boolean; connection: string | undefined };

function send(
  agent: http.Agent,
  method: string,
  path: string,
  { headers = {}, chunks = [] as string[] } = {}
): Promise<Sent> {
  const { hostname, port } = new URL(BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, agent, headers }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket, connection: res.headers.connection })
      );
    });
    req.on("error", reject);
    let next = 0;
    const pump = () => {
      while (next < chunks.length) {
        if (!req.write(chunks[next++])) return void req.once("drain", pump);
      }
      req.end();
    };
    pump();
  });
}

test("the server keeps an idle connection open past its default five-second timeout", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    expect((await send(agent, "GET", "/api/auth/me", { headers: ADMIN_AUTH })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 7_000));

    const again = await send(agent, "GET", "/api/auth/me", { headers: ADMIN_AUTH });
    expect(again).toMatchObject({ status: 200, reused: true });
  } finally {
    agent.destroy();
  }
});

test("a body over the cap is refused with 413 and a closed connection, and the next request succeeds", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const overCap = Array.from({ length: Math.ceil(MAX_JSON_BODY_BYTES / 1024) + 16 }, () => "x".repeat(1024));
  try {
    const refused = await send(agent, "POST", "/api/auth/login", {
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json" },
      chunks: ['{"username":"', ...overCap, '","password":"p"}'],
    });
    expect(refused).toMatchObject({ status: 413, connection: "close" });

    expect((await send(agent, "GET", "/api/auth/me", { headers: ADMIN_AUTH })).status).toBe(200);
  } finally {
    agent.destroy();
  }
});

test("an oversized task write is refused and the next request on the same client succeeds", async ({
  request,
}) => {
  const refused = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { description: "x".repeat(TASK_DESCRIPTION_MAX_LENGTH * 10) },
  });
  expect(refused.status()).toBe(400);

  const read = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, {
    headers: ADMIN_AUTH,
  });
  expect(read.status()).toBe(200);
});
