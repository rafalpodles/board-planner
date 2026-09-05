import { test, expect, type APIRequestContext } from "@playwright/test";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { seed } from "./seed";

/**
 * BP-520. Every outage used to leave the app holding a MongoClient nobody could reach: mongoose
 * assigns the client to the connection before awaiting `connect()`, and the reconnect overwrote
 * that reference without closing it. The abandoned topology monitor keeps polling, so the
 * connections through the proxy climb one client per outage and never come down.
 *
 * Nothing about this is visible in a page, which is why it is asserted here against the proxy's own
 * count rather than in the browser: `GET /sockets` on the control port is the only witness the app
 * has no way to fake.
 */

const CYCLES = 6;
// The abandoned monitors re-establish on the driver's heartbeat rather than at once, so a count
// read straight after the last restore says nothing. Measured: without the fix it reaches 3 after
// two seconds and 13 after seventeen.
const SETTLE_MS = 18_000;

const sockets = async (request: APIRequestContext): Promise<number> =>
  (await (await request.get(`${MONGO_PROXY_CONTROL_URL}/sockets`)).json()).live;

const board = (request: APIRequestContext) => request.get("/api/projects", { headers: ADMIN_AUTH });

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async ({ request }) => {
  await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);
});

test("an outage does not leave a connection behind", async ({ request }) => {
  test.setTimeout(180_000);

  expect((await board(request)).status()).toBe(200);
  const baseline = await sockets(request);
  expect(baseline).toBeGreaterThan(0);

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    await request.post(`${MONGO_PROXY_CONTROL_URL}/outage`);
    // The control on the way down: the app noticed, so the reconnect this test is about did run
    await expect(async () => {
      expect((await board(request)).status()).toBe(503);
    }).toPass({ timeout: 20_000 });

    await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);
    // The control on the way up: the close did not take the connection the app is using with it
    await expect(async () => {
      expect((await board(request)).status()).toBe(200);
    }).toPass({ timeout: 30_000 });
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  // One spare over the baseline: the live connection's own monitor socket comes and goes, and this
  // has to fail on a client per cycle, not on one reconnect in flight
  expect(await sockets(request)).toBeLessThanOrEqual(baseline + 1);
  expect((await board(request)).status()).toBe(200);
});
