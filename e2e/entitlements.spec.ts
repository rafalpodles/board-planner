import { test, expect } from "@playwright/test";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { seed } from "./seed";

/**
 * BP-649. Nothing is gated on a feature yet and there is no Settings page, so this route has no
 * click-through surface — the honest e2e here is the real running server answering the real
 * request, the same shape bounded-bodies.spec.ts uses for routes with no UI of their own.
 */

test.beforeEach(async () => {
  await seed();
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

test("the singleton survives across requests — an admin sees the same untouched default", async ({
  request,
}) => {
  const first = await request.get("/api/entitlements", { headers: ADMIN_AUTH });
  const second = await request.get("/api/entitlements", { headers: MEMBER_AUTH });

  expect(await first.json()).toEqual(await second.json());
});
