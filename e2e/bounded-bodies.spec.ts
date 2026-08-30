import { test, expect } from "@playwright/test";
import { SAME_ORIGIN } from "./api";
import { ADMIN_USERNAME, ADMIN_PASSWORD, PROJECT_KEY, seed } from "./seed";
import { PROTOCOL_VERSION } from "@/lib/worker-service";

/**
 * BP-322. Route Handlers have no body size limit of their own, so every handler that runs before
 * any credential is checked used to buffer whatever it was sent and hand it to JSON.parse.
 *
 * The unit tests measure what `readJsonBody` pulls off a stream; this measures whether the running
 * server refuses at all, because the claim being tested is about the Next runtime rather than about
 * a function. Each refusal is paired with the honest request on the same route: a cap that also
 * turned away real callers would be a worse bug than the one it closes, and asserting only the 413
 * cannot tell the two apart.
 */

const OVERSIZE = "a".repeat(300 * 1024);

// The enrolment routes answer 409 to a client speaking another protocol, and that check is a
// header read that now runs ahead of the body — so without this the oversized-body test would be
// asserting the protocol refusal instead.
const WORKER = { ...SAME_ORIGIN, "x-cp-protocol": String(PROTOCOL_VERSION) };

test.beforeEach(async () => {
  await seed();
});

const UNAUTHENTICATED = [
  { name: "login", path: "/api/auth/login", honest: { username: "nobody", password: "nope" } },
  { name: "password reset request", path: "/api/auth/forgot", honest: { identifier: "nobody" } },
  { name: "password reset", path: "/api/auth/reset", honest: { token: "nope", newPassword: "x" } },
  { name: "device enrolment", path: "/api/workers/enrolment/device", honest: { name: "laptop" } },
  {
    name: "enrolment poll",
    path: "/api/workers/enrolment/device/token",
    honest: { deviceCode: "cpd_nope" },
  },
];

test.describe("handlers that run before any credential is checked", () => {
  for (const route of UNAUTHENTICATED) {
    test(`${route.name} refuses an oversized body`, async ({ request }) => {
      const response = await request.post(route.path, {
        headers: WORKER,
        data: { padding: OVERSIZE },
      });

      expect(response.status(), await response.text()).toBe(413);
    });

    test(`${route.name} still answers an ordinary body`, async ({ request }) => {
      const response = await request.post(route.path, {
        headers: WORKER,
        data: route.honest,
      });

      // The control. What the answer IS depends on the route — wrong password, unknown identifier,
      // protocol mismatch — and none of that matters here. What matters is that the cap did not
      // turn it away: a 413 on this line is the fix refusing honest input.
      expect(response.status(), await response.text()).not.toBe(413);
    });
  }

  test("a real sign-in still works, all the way through", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      headers: SAME_ORIGIN,
      data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    expect(response.status(), await response.text()).toBe(200);
  });
});

test.describe("uploads", () => {
  test("refuses an oversized upload before it is allocated", async ({ request }) => {
    await request.post("/api/auth/login", {
      headers: SAME_ORIGIN,
      data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    const response = await request.post("/api/uploads", {
      headers: SAME_ORIGIN,
      multipart: {
        projectId: PROJECT_KEY,
        file: {
          name: "big.png",
          mimeType: "image/png",
          buffer: Buffer.alloc(6 * 1024 * 1024),
        },
      },
    });

    expect(response.status(), await response.text()).toBe(413);
  });

  /**
   * The test above cannot tell the fix from the bug: with the Content-Length check removed, the 6 MB
   * part is parsed and then refused by the file-size check with the same 413. Verified — that
   * mutation left it green.
   *
   * This one separates them. The envelope is over the request ceiling while the file itself is
   * under the 5 MB limit, so only a check that reads Content-Length can refuse it; the check that
   * reads file.size has to allocate the whole body first and then finds nothing wrong with it.
   */
  test("refuses an envelope over the ceiling even when the file inside it is not", async ({
    request,
  }) => {
    await request.post("/api/auth/login", {
      headers: SAME_ORIGIN,
      data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    const response = await request.post("/api/uploads", {
      headers: SAME_ORIGIN,
      multipart: {
        projectId: PROJECT_KEY,
        padding: "p".repeat(400 * 1024),
        file: {
          name: "under-the-limit.png",
          mimeType: "image/png",
          buffer: Buffer.alloc(5 * 1000 * 1000),
        },
      },
    });

    expect(response.status(), await response.text()).toBe(413);
  });

  test("still accepts an ordinary attachment — the control", async ({ request }) => {
    await request.post("/api/auth/login", {
      headers: SAME_ORIGIN,
      data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    const response = await request.post("/api/uploads", {
      headers: SAME_ORIGIN,
      multipart: {
        projectId: PROJECT_KEY,
        file: { name: "small.png", mimeType: "image/png", buffer: Buffer.alloc(1024) },
      },
    });

    expect(response.status(), await response.text()).not.toBe(413);
  });
});
