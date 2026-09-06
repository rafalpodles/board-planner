import { test, expect, type APIRequestContext } from "@playwright/test";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { seed } from "./seed";

const CYCLES = 6;
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
    await expect(async () => {
      expect((await board(request)).status()).toBe(503);
    }).toPass({ timeout: 20_000 });

    await request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);
    await expect(async () => {
      expect((await board(request)).status()).toBe(200);
    }).toPass({ timeout: 30_000 });
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  expect(await sockets(request)).toBeLessThanOrEqual(baseline + 2);
  expect((await board(request)).status()).toBe(200);
});
