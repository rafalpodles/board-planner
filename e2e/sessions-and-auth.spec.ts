import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";

/**
 * BP-395. The session is the one thing every other spec assumes and none of them exercises: they
 * sign in, and from there the cookie is furniture. So the four gestures that end or refuse a
 * session had no coverage at all — the Logout control was explicitly stepped around in
 * admin-sets-password.spec.ts ("that control lives behind the sidebar's user menu"), and expiry,
 * the login throttle and the profile password change were reachable only through unit tests that
 * mock the store the behaviour lives in.
 *
 * Two things here are driven by writing to the database rather than by waiting:
 *
 * - **Expiry.** The idle window is 30 days and the absolute cap 90; no test can wait for either.
 *   The row's own timestamps are moved into the past instead, which is exactly the state the
 *   clock would produce. What is *not* faked is the reading of it: the browser then makes an
 *   ordinary request and the server decides.
 * - **Nothing about the throttle.** The counters are filled by real refused logins through the
 *   real endpoint, one request per attempt.
 *
 * The throttle numbers deserve their own note. `TRUSTED_PROXY_HOPS` is unset here, as it is on the
 * compose deployment the README documents, so `getClientIp` returns null and every caller shares
 * the anonymous account bucket at `ANONYMOUS_ACCOUNT_ATTEMPTS` (50) rather than the per-address
 * `MAX_ATTEMPTS` (10). Forging `X-Forwarded-For` would move the test onto a per-address counter
 * that this configuration does not use — the header BP-318 stopped trusting — so it is left alone
 * and the test pays for the fifty attempts.
 */

// One below the threshold, so the last refused attempt is still credential-shaped and the next one
// is the throttle. That pair is the assertion: neither number is asserted directly, so a threshold
// moved in either direction fails this spec rather than passing it quietly.
const ATTEMPTS_BEFORE_THROTTLE = 49;

const NEW_PASSWORD = "a-much-better-password";
const TASK_PATH = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const THROTTLED = "Too many failed attempts. Try again later.";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function sessionsOf(userId: mongoose.Types.ObjectId) {
  return (await db()).collection("sessions").find({ user: userId }).toArray();
}

/**
 * The Next.js dev-tools badge is a portal anchored bottom-left, which is exactly where the
 * sidebar's user menu lives, and it takes the click. It exists only under `next dev` — the
 * production build ships no such element — so hiding it keeps the gesture honest rather than
 * papering over something a user would meet.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

async function signInFrom(page: Page, username: string, password: string, from = "/login") {
  await page.goto(from);
  await signIn(page, username, password);
}

async function signInAsMember(page: Page) {
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
}

/** The session row the browser is holding, whoever it belongs to. */
async function onlySessionOf(userId: mongoose.Types.ObjectId) {
  const rows = await sessionsOf(userId);
  expect(rows, "expected exactly one session for this account").toHaveLength(1);
  return rows[0];
}

async function expireSession(
  userId: mongoose.Types.ObjectId,
  when: { expiresAt: Date; absoluteExpiresAt: Date }
) {
  const handle = await db();
  await handle.collection("sessions").updateOne({ user: userId }, { $set: when });
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

/**
 * Refused logins through the real endpoint, filling the real counter.
 *
 * Fired in batches rather than one at a time because each one pays for a bcrypt comparison — the
 * miss path deliberately does, to close the username oracle — and fifty of those in series is most
 * of a minute. The count is safe under concurrency: `recordFailedAttempt` is a single atomic update
 * pipeline, which is what BP-318 changed it to after 1000 concurrent failures recorded a count of 1.
 */
async function burnLoginAttempts(request: APIRequestContext, attempts: number) {
  const batch = 8;
  for (let sent = 0; sent < attempts; sent += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, attempts - sent) }, () =>
        request.post("/api/auth/login", {
          headers: SAME_ORIGIN,
          data: { username: MEMBER_USERNAME, password: "not-the-password" },
        })
      )
    );
  }
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("Logout ends the session on the server, not only in the tab", async ({ page }) => {
  await signInAsMember(page);
  // The control: the session works before the gesture, so a redirect afterwards is the gesture's
  // doing and not a fixture that never signed anybody in
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

  await hideDevOverlay(page);
  await page.getByRole("button", { name: /E2E Member/ }).click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL(/\/login/);
  // Clearing the cookie would produce this same screen with the row still standing, and a row that
  // outlives the logout is a live credential for whoever copied it
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

  // And the browser is not holding one either: going back to the board is a fresh request
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page).toHaveURL(/\/login/);
});

test("an idle session sends you to sign in, and then back where you were going", async ({
  page,
}) => {
  await signInAsMember(page);

  await page.goto(TASK_PATH);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  // Idle, not absolute: the cap is still months away, so only the sliding window has run out
  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(-1),
    absoluteExpiresAt: hoursFromNow(24 * 60),
  });

  await page.goto(TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);

  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);

  // The whole point of carrying the path: the link is honoured, not swallowed by a bounce to the
  // project list
  await expect(page).toHaveURL(new RegExp(`${TASK_PATH}$`));
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
});

test("a session past its absolute cap is refused even though the idle window is live", async ({
  page,
}) => {
  await signInAsMember(page);

  // The mirror image of the test above, and the reason both exist: a server that checked only the
  // sliding window would pass that one and this is where it fails
  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(24 * 30),
    absoluteExpiresAt: hoursFromNow(-1),
  });

  await page.goto(TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);
});

test("the sign-in form names the throttle, and the throttle refuses the right password too", async ({
  page,
  request,
}) => {
  await burnLoginAttempts(request, ATTEMPTS_BEFORE_THROTTLE - 1);

  // The control, one attempt below the threshold: still a credentials answer, so everything after
  // this is the counter reaching its limit rather than a fixture that was refusing all along
  const lastBeforeThrottle = await request.post("/api/auth/login", {
    headers: SAME_ORIGIN,
    data: { username: MEMBER_USERNAME, password: "not-the-password" },
  });
  expect(lastBeforeThrottle.status()).toBe(401);
  expect((await lastBeforeThrottle.json()).error).toBe("Invalid credentials");

  // The one that trips it, through the form, because the message is the deliverable — a 429 nobody
  // renders is a status code, not an explanation
  await signInFrom(page, MEMBER_USERNAME, "not-the-password");
  await expect(page.getByText(THROTTLED)).toBeVisible();

  // And the part that makes it a lockout rather than a slow "wrong password": the real one is
  // refused as well, in the same words
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page.getByText(THROTTLED)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  // Read from the database, because a form that stayed put is also what a slow redirect looks like
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);
});

test("changing your own password: the new one works, the old one stops, this device stays", async ({
  page,
}) => {
  await signInAsMember(page);
  const before = await onlySessionOf(MEMBER_ID);

  await page.goto("/settings/security");
  await page.getByLabel("Current password").fill(MEMBER_PASSWORD);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByText("Password changed")).toBeVisible();

  // The screen promises "You stay signed in on this device", and it is the same row rather than a
  // reissued one — a re-login here would look identical from the outside
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  expect(String((await onlySessionOf(MEMBER_ID))._id)).toBe(String(before._id));

  await page.context().clearCookies();
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page.getByText("Invalid credentials")).toBeVisible();

  await signIn(page, MEMBER_USERNAME, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("changing your own password lifts a login lockout", async ({ browser, page, request }) => {
  // Signed in on this device before the lockout exists — which is the situation the exit is for:
  // the person locked out at the sign-in form is the same person already holding a session
  // somewhere else, and BP-347 is about them not having to wait out a window they cannot see.
  await signInAsMember(page);

  await burnLoginAttempts(request, ATTEMPTS_BEFORE_THROTTLE + 1);
  const lockedOut = await browser.newContext();
  try {
    const phone = await lockedOut.newPage();
    await signInFrom(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone.getByText(THROTTLED)).toBeVisible();

    await page.goto("/settings/security");
    await page.getByLabel("Current password").fill(MEMBER_PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    // Not the throttle's words any more. Asserted before the successful login, because a success
    // clears the account counter by itself and would hide whether the password change had.
    await signIn(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone.getByText("Invalid credentials")).toBeVisible();

    await signIn(phone, MEMBER_USERNAME, NEW_PASSWORD);
    await expect(phone).toHaveURL(/\/projects/);
  } finally {
    await lockedOut.close();
  }
});

test("changing your own password ends the sessions on other devices", async ({ browser, page }) => {
  await signInAsMember(page);

  const other = await browser.newContext();
  try {
    const phone = await other.newPage();
    await signInFrom(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone).toHaveURL(/\/projects/);
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(2);

    await page.goto("/settings/security");
    await page.getByLabel("Current password").fill(MEMBER_PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    await phone.reload();
    await expect(phone).toHaveURL(/\/login/);

    // The one left is this device's, so the revocation was aimed rather than total
    const remaining = await onlySessionOf(MEMBER_ID);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    expect(remaining).toBeTruthy();
  } finally {
    await other.close();
  }
});
