import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { ADMIN_SESSION_TOKEN, API_TOKEN, E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";
import { sha256 } from "../src/lib/oauth";

const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

// BP-665: a credential works only for the organisation its person belongs to
test("an API token whose organisation is not its person's opens nothing", async ({ request }) => {
  expect((await request.get("/api/projects", { headers: ADMIN_AUTH })).status()).toBe(200);

  await (await db()).collection("apitokens").updateOne({ prefix: API_TOKEN.slice(0, 11) }, { $set: { organisation: ELSEWHERE } });

  expect((await request.get("/api/projects", { headers: ADMIN_AUTH })).status()).toBe(401);
});

test("a session whose organisation is not its person's signs nobody in, on screen", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects/);

  await (await db()).collection("sessions").updateOne({ tokenHash: sha256(ADMIN_SESSION_TOKEN) }, { $set: { organisation: ELSEWHERE } });

  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login/);
});
