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

// `answers` is the status each route gives its honest payload today. Asserting the exact number
// rather than "not 413" is what makes these controls controls: `.not.toBe(413)` was satisfied by a
// route returning 500 for everything, so four of the five proved only that the server was running.
const UNAUTHENTICATED = [
  { name: "login", path: "/api/auth/login", honest: { username: "nobody", password: "nope" }, answers: 401 },
  // 503 because this instance has no SMTP configured, which is the point: the request reached
  // the route's own logic instead of being turned away by the cap.
  { name: "password reset request", path: "/api/auth/forgot", honest: { identifier: "nobody" }, answers: 503 },
  { name: "password reset", path: "/api/auth/reset", honest: { token: "nope", newPassword: "x" }, answers: 400 },
  { name: "device enrolment", path: "/api/workers/enrolment/device", honest: { name: "laptop" }, answers: 201 },
  {
    name: "enrolment poll",
    path: "/api/workers/enrolment/device/token",
    honest: { deviceCode: "cpd_nope" },
    answers: 410,
  },
  // The bootstrap branch of this one reads its body before it looks at a credential, so the cap
  // has to be in front of that too. On a seeded instance the honest answer is the refusal.
  {
    name: "user creation",
    path: "/api/users",
    honest: { username: "someone", password: "a-long-enough-password", fullName: "Someone" },
    answers: 403,
  },
  // The four below were missed by the first enumeration: it searched src/app/api, and the OAuth
  // routes live in src/app/oauth; and it matched the word "withAdmin" in a COMMENT on
  // workers/register. Each reads a body before it checks a credential.
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

// Form-encoded rather than JSON, and unauthenticated with no throttle at all, so the cap is the
// only bound they have.
// `unreadable` is the answer each gives a body it could not read. Asserting the status alone would
// not do: an uncapped route parses the oversized form and then refuses it as a bad grant, with the
// same 400. The text is what separates "refused before reading" from "read, then disliked".
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

      // These answer RFC 6749 error codes rather than 413: an over-cap body is unreadable, which
      // is invalid_request, and a machine client acts on that.
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
