import { test, expect } from "@playwright/test";
import { SAME_ORIGIN } from "./api";
import { ADMIN_USERNAME, ADMIN_PASSWORD, PROJECT_KEY, seed } from "./seed";
import { PROTOCOL_VERSION } from "@/lib/worker-service";

const OVERSIZE = "a".repeat(300 * 1024);

const WORKER = { ...SAME_ORIGIN, "x-cp-protocol": String(PROTOCOL_VERSION) };

test.beforeEach(async () => {
  await seed();
});

const UNAUTHENTICATED = [
  { name: "login", path: "/api/auth/login", honest: { username: "nobody", password: "nope" }, answers: 401 },
  { name: "password reset request", path: "/api/auth/forgot", honest: { identifier: "nobody" }, answers: 503 },
  { name: "password reset", path: "/api/auth/reset", honest: { token: "nope", newPassword: "x" }, answers: 400 },
  { name: "device enrolment", path: "/api/workers/enrolment/device", honest: { name: "laptop" }, answers: 201 },
  {
    name: "enrolment poll",
    path: "/api/workers/enrolment/device/token",
    honest: { deviceCode: "cpd_nope" },
    answers: 410,
  },
  {
    name: "user creation",
    path: "/api/users",
    honest: { username: "someone", password: "a-long-enough-password", fullName: "Someone" },
    answers: 403,
  },
  {
    name: "worker registration",
    path: "/api/workers/register",
    honest: { name: "laptop", host: "office" },
    answers: 401,
  },
  {
    name: "OAuth client registration",
    path: "/oauth/register",
    honest: { redirect_uris: [] },
    answers: 400,
  },
];

const OAUTH_FORMS = [
  { name: "OAuth token", path: "/oauth/token", unreadable: /x-www-form-urlencoded/ },
  { name: "OAuth authorize", path: "/oauth/authorize", unreadable: /not a form/ },
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

      expect(response.status(), await response.text()).toBe(route.answers);
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

test.describe("the OAuth endpoints, which take a form", () => {
  for (const route of OAUTH_FORMS) {
    test(`${route.name} refuses an oversized form`, async ({ request }) => {
      const response = await request.post(route.path, {
        headers: SAME_ORIGIN,
        form: { grant_type: "authorization_code", code: OVERSIZE },
      });

      const body = await response.text();
      expect(response.status(), body).toBe(400);
      expect(body).toMatch(route.unreadable);
    });
  }
});

test.describe("uploads", () => {
  test("refuses an upload whose file is over the limit", async ({ request }) => {
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

    const body = await response.text();
    expect(response.status(), body).toBe(413);
    expect(body).toMatch(/Maximum size is 5MB/);
  });

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

    const body = await response.text();
    expect(response.status(), body).toBe(413);
    expect(body).toMatch(/Maximum size is 5MB/);
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
