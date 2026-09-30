import { test, expect } from "@playwright/test";
import http from "node:http";
import { BASE_URL, RUN_AGAINST_PRODUCTION_BUILD } from "../playwright.config";

/**
 * BP-814. Railway's edge keeps an idle upstream connection for 60 s and sends the next request on
 * it. A server that closes it first resets that request, and the person sees a 502.
 */

test.skip(!RUN_AGAINST_PRODUCTION_BUILD, "only npm start over a production build is what Railway runs");

const RAILWAY_EDGE_IDLE_MS = 60_000;

function get(agent: http.Agent): Promise<{ status: number; reused: boolean }> {
  const { hostname, port } = new URL(BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: "/login", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a connection idle as long as Railway's edge keeps one is still open for the next request", async () => {
  test.setTimeout(RAILWAY_EDGE_IDLE_MS + 60_000);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    expect((await get(agent)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, RAILWAY_EDGE_IDLE_MS + 2_000));

    expect(await get(agent)).toEqual({ status: 200, reused: true });
  } finally {
    agent.destroy();
  }
});
