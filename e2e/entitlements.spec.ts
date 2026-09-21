import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { E2E_MONGODB_URI, seed } from "./seed";

/**
 * BP-649. Nothing is gated on a feature yet and there is no Settings page, so this route has no
 * click-through surface — the honest e2e here is the real running server answering the real
 * request, the same shape bounded-bodies.spec.ts uses for routes with no UI of their own.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("answers the tenant's plan and features for any authenticated user", async ({ request }) => {
  const response = await request.get("/api/entitlements", { headers: MEMBER_AUTH });

  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ plan: "free", features: [], expiresAt: null });
});

test("401s without credentials", async ({ request }) => {
  const response = await request.get("/api/entitlements");

  expect(response.status(), await response.text()).toBe(401);
});

// A read that recreated the singleton instead of finding the existing one would silently reset
// it back to the default — two such reads would still agree with each other, since the default
// is deterministic. Seeding a value the default cannot produce, and requiring both reads to
// return exactly that value, is what actually tells "found it" apart from "made a fresh one".
test("reads the existing singleton rather than inserting a fresh default over it", async ({
  request,
}) => {
  const handle = await db();
  await handle.collection("tenants").insertOne({
    entitlements: {
      plan: "pro",
      features: ["integrations.jira"],
      source: "service",
      customer: "acme-e2e-marker",
    },
  });

  const first = await request.get("/api/entitlements", { headers: ADMIN_AUTH });
  const second = await request.get("/api/entitlements", { headers: MEMBER_AUTH });

  const expected = { plan: "pro", features: ["integrations.jira"], expiresAt: null };
  expect(await first.json()).toEqual(expected);
  expect(await second.json()).toEqual(expected);
});
