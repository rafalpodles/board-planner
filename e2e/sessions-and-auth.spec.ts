import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { ANONYMOUS_ACCOUNT_ATTEMPTS } from "@/lib/rate-limit";
import { SAME_ORIGIN } from "./api";
import {
  ADMIN_ID,
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
 * sign in, and from there the cookie is furniture. So the gestures that end, refuse or restore a
 * session had no coverage at all — the Logout control was explicitly stepped around in
 * admin-sets-password.spec.ts ("that control lives behind the sidebar's user menu"), and expiry,
 * the login throttle and the profile password change were reachable only through unit tests that
 * mock the store the behaviour lives in.
 *
 * Two things here are driven by writing to the database rather than by waiting:
 *
 * - **Expiry.** The idle window is 30 days, the absolute cap 90, and the throttle's window 15
 *   minutes; no test can wait for any of them. The stored timestamps are moved instead, which is
 *   the state the clock would produce. What is *not* faked is the reading of them: the browser
 *   then makes an ordinary request and the server decides.
 * - **The reset link**, planted as a delivered email would leave it — the same fixture
 *   reset-by-email.spec.ts uses, and for the same reason: CI has no mail server.
 *
 * **This file needs a database of its own** — `E2E_MONGODB_URI`, and its own `E2E_PORT` /
 * `PM_STUB_PORT` with it. Almost every other spec asserts on named rows; this one counts them, in
 * `sessions` and `ratelimits`, which every signing-in spec writes to. A second suite sharing the
 * database does not make these tests wrong, it makes them fail.
 *
 * Nothing about the throttle is faked. The counters are filled by real refused logins through the
 * real endpoint, one request per attempt, and the threshold is imported rather than copied.
 *
 * That threshold deserves a note. `TRUSTED_PROXY_HOPS` is 0 here, as it is on the compose
 * deployment the README documents, so `getClientIp` returns null and every caller shares the
 * anonymous account bucket (`ANONYMOUS_ACCOUNT_ATTEMPTS`, 50) rather than the per-address
 * `MAX_ATTEMPTS` (10). Forging `X-Forwarded-For` would move these tests onto a counter this
 * configuration does not use — the header BP-318 stopped trusting — so it is left alone and the
 * tests pay for the attempts.
 */

const NEW_PASSWORD = "a-much-better-password";
const TASK_PATH = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const THROTTLED = "Too many failed attempts. Try again later.";
const WRONG_PASSWORD = "not-the-password";
const HOUR = 60 * 60 * 1000;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function sessionsOf(userId: mongoose.Types.ObjectId) {
  return (await db()).collection("sessions").find({ user: userId }).toArray();
}

/** The single session row an account is expected to be holding, returned so it can be compared. */
async function onlySessionOf(userId: mongoose.Types.ObjectId) {
  const rows = await sessionsOf(userId);
  expect(rows, "expected exactly one session for this account").toHaveLength(1);
  return rows[0];
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

/**
 * The Next.js dev-tools badge is a portal anchored bottom-left, which is exactly where the
 * sidebar's user menu lives, and it takes the click. It exists only under `next dev` — the
 * production build ships no such element — so hiding it keeps the gesture honest rather than
 * papering over something a user would meet.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/**
 * Moves a session's own timestamps, and insists it moved one. `updateOne` is silent about matching
 * nothing, and a silent miss reads exactly like a working expiry check: both end in a redirect.
 */
async function expireSession(
  userId: mongoose.Types.ObjectId,
  when: { expiresAt: Date; absoluteExpiresAt: Date }
) {
  const handle = await db();
  const result = await handle.collection("sessions").updateOne({ user: userId }, { $set: when });
  expect(result.matchedCount, "expected exactly one session row to expire").toBe(1);
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR);

/**
 * The login account counter, which is what a lockout and its lifting are about.
 *
 * Named by what it *is*, not by excluding the one other key a refused login writes. The password
 * form has its own counter under a `password-change:` scope, so a helper that took everything but
 * `login:source:` would start matching two rows the moment a test fumbled a current password —
 * and fail with a message about this fixture rather than about the product.
 */
async function accountCounter() {
  const rows = (await (await db()).collection("ratelimits").find({}).toArray()).filter(
    (row) =>
      String(row._id).startsWith("login:") && !String(row._id).startsWith("login:source:")
  );
  expect(rows, "expected exactly one account counter").toHaveLength(1);
  return rows[0];
}

/**
 * Refused logins through the real endpoint, filling the real counter.
 *
 * Fired in batches rather than one at a time because each pays for a bcrypt comparison — the miss
 * path deliberately does, to close the username oracle — and fifty in series is most of a minute.
 * The count is safe under concurrency: `recordFailedAttempt` is a single atomic update pipeline,
 * which is what BP-318 changed it to after 1000 concurrent failures recorded a count of 1.
 *
 * Do not "simplify" the batching away. Concurrent attempts against one counter are what the
 * read-modify-write this replaced got wrong, and this is the only place in the repository where
 * that atomicity is exercised against a real MongoDB rather than an in-memory stand-in.
 *
 * Every status is asserted. A request that never reached the counter — a transport reset on a
 * shared machine, a 500 — would otherwise surface forty lines later as a missing throttle message,
 * which reads as a broken throttle rather than as a lost request.
 */
async function burnLoginAttempts(request: APIRequestContext, attempts: number) {
  const batch = 8;
  for (let sent = 0; sent < attempts; sent += batch) {
    const answers = await Promise.all(
      Array.from({ length: Math.min(batch, attempts - sent) }, () =>
        request.post("/api/auth/login", {
          // A different forged address on every attempt. At TRUSTED_PROXY_HOPS=0 the header is not
          // read at all, so all fifty must still land in one bucket; read unconditionally — the
          // shape before BP-318 — each would open its own counter at 1 and the threshold would
          // never be reached, which is unlimited guessing against a named account from one machine.
          headers: { ...SAME_ORIGIN, "X-Forwarded-For": `203.0.113.${(sent % 250) + 1}` },
          data: { username: MEMBER_USERNAME, password: WRONG_PASSWORD },
        })
      )
    );
    for (const answer of answers) {
      expect(answer.status(), await answer.text()).toBe(401);
    }
  }
}

/** Locks the member out, and proves it by the status of the attempt that trips the threshold. */
async function lockOutMember(request: APIRequestContext) {
  await burnLoginAttempts(request, ANONYMOUS_ACCOUNT_ATTEMPTS - 1);
  const tripping = await request.post("/api/auth/login", {
    headers: SAME_ORIGIN,
    data: { username: MEMBER_USERNAME, password: WRONG_PASSWORD },
  });
  expect(tripping.status(), await tripping.text()).toBe(429);
}

/** What the app would have stored when it emailed the member a reset link. */
async function plantResetLink() {
  const token = `cpr_${randomBytes(32).toString("hex")}`;
  await (await db()).collection("passwordresettokens").insertOne({
    user: MEMBER_ID,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + HOUR),
    usedAt: null,
    createdAt: new Date(),
  });
  return token;
}

async function changeOwnPassword(page: Page, current: string, next: string) {
  await page.goto("/settings/security");
  await page.getByLabel("Current password").fill(current);
  // exact, because "New password" is a substring of "Confirm new password"
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password").fill(next);
  await page.getByRole("button", { name: "Change password" }).click();
}

/** The server's own refusal, so a redirect is not the only evidence a session was rejected. */
async function refusedAt(page: Page, path: string) {
  const [me] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/me") && r.request().method() === "GET"
    ),
    page.goto(path),
  ]);
  expect(me.status()).toBe(401);
}

/** Proves the browser's cookie is still honoured by the *server*, not merely that a URL stuck. */
async function loadsAuthenticated(page: Page, path: string) {
  const [me] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/me") && r.request().method() === "GET" && r.status() === 200
    ),
    page.goto(path),
  ]);
  expect(me.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

/**
 * The two reapers, held off for this file.
 *
 * `sessions` is TTL-indexed on `expiresAt` and `ratelimits` on `resetAt`, both at
 * `expireAfterSeconds: 0`. Every expiry in this file is produced by moving exactly those fields
 * into the past, which also makes the row eligible for Mongo's own monitor — and that monitor
 * sweeps about once a minute, so a test that then asks the server to refuse is racing a deletion
 * it does not want.
 *
 * Both directions of that race are bad, and the first version of this file lost the worse one.
 * Where a row is *supposed* to survive, asserting so failed on a healthy build roughly one run in
 * four. Where a lapsed throttle window is the subject, the reaper is worse still: delete the
 * counter and the login succeeds because the document is *gone*, which is precisely the confusion
 * `src/lib/rate-limit.ts` warns about in its own comment — "every read filters on `resetAt` rather
 * than trusting the document's existence" — so the one test standing over that filter could be
 * satisfied by the document's absence and report green on a throttle that never lets anybody go.
 *
 * With no TTL index there is no reaper, so a refusal or an admission can only have come from the
 * code under test. Dropped once for the file and put back afterwards; both collections are emptied
 * per test anyway, and nothing else in the suite depends on either index — the application checks
 * both windows itself, in code these tests exercise.
 */
const TTL_INDEXES: [collection: string, index: string, field: string][] = [
  ["sessions", "expiresAt_1", "expiresAt"],
  ["ratelimits", "resetAt_1", "resetAt"],
];

test.beforeAll(async () => {
  const handle = await db();
  for (const [collection, index] of TTL_INDEXES) {
    await handle.collection(collection).dropIndex(index).catch(() => {});
  }
  await mongoose.disconnect();
});

test.afterAll(async () => {
  const handle = await db();
  for (const [collection, , field] of TTL_INDEXES) {
    await handle
      .collection(collection)
      .createIndex({ [field]: 1 }, { expireAfterSeconds: 0 })
      .catch(() => {});
  }
  await mongoose.disconnect();
});

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("Logout ends the session on the server, not only in the tab", async ({ page }) => {
  await signInAsMember(page);
  // The control: the session exists before the gesture, so a redirect afterwards is the gesture's
  // doing and not a fixture that never signed anybody in
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

  await hideDevOverlay(page);
  await page.getByRole("button", { name: /E2E Member/ }).click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL(/\/login/);
  // Clearing the cookie would produce this same screen with the row still standing, and a row that
  // outlives the logout is a live credential for whoever copied it
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

  // And the browser is not holding one either. Asserted on the jar rather than on the next
  // request: with the row already deleted, /api/auth/me answers 401 whether or not the cookie was
  // cleared, so a redirect says nothing about the Set-Cookie the route sends.
  const jar = await page.context().cookies();
  expect(jar.filter((c) => c.name.endsWith("bp_session") && c.value)).toHaveLength(0);
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

  await refusedAt(page, TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);

  // Deterministic because the TTL index is off for this file: the row can only still be here, so
  // the refusal above came from the idle comparison rather than from an absent row — a different
  // code path, and one that would leave this test unable to fail if that comparison were deleted.
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

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

  // The control, next to the case rather than in the neighbouring test: without it a session that
  // never worked at all — a cookie never set, a hash never matched — produces this same redirect
  await page.goto(TASK_PATH);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  // The mirror image of the test above, and the reason both exist: a server that checked only the
  // sliding window would pass that one and fail here
  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(24 * 30),
    absoluteExpiresAt: hoursFromNow(-1),
  });

  await refusedAt(page, TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);
  // Still there — the refusal is the absolute comparison, not an absent row
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);
});

test("a live session's idle window slides forward as it is used, never past the absolute cap", async ({
  page,
}) => {
  await signInAsMember(page);

  // An hour left, so the extension is worth writing: the slide is throttled to one write a day
  // (SESSION_SLIDE_THROTTLE_MS) and a session created seconds ago has nothing to move
  const distantCap = hoursFromNow(24 * 60);
  await expireSession(MEMBER_ID, { expiresAt: hoursFromNow(1), absoluteExpiresAt: distantCap });

  await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);

  // Without this nothing pins the *other* direction: a server that stopped sliding would sign
  // everybody out 30 days after they first signed in, and every other test here would still pass
  const slid = await onlySessionOf(MEMBER_ID);
  expect(new Date(slid.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
  // And the cap does not move with it. One line added to that same write — extending
  // `absoluteExpiresAt` too — turns the ninety-day cap into a second sliding window, so a session
  // in daily use never dies. Nothing else here would notice: the absolute-cap test refuses before
  // this write is reached, and every other session in the file is seconds old.
  expect(new Date(slid.absoluteExpiresAt as Date).getTime()).toBe(distantCap.getTime());

  // The clamp, which needs a cap nearer than the idle window to be visible at all: the extension
  // is `min(now + 30 days, absoluteExpiresAt)`, and without the min a session five days from its
  // cap would be handed thirty — the cap overwritten by the very mechanism that must respect it.
  const nearCap = hoursFromNow(24 * 5);
  await expireSession(MEMBER_ID, { expiresAt: hoursFromNow(1), absoluteExpiresAt: nearCap });

  await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);

  const clamped = await onlySessionOf(MEMBER_ID);
  expect(new Date(clamped.expiresAt as Date).getTime()).toBe(nearCap.getTime());
});

test("a session that expires while the app is open signs the tab out by itself", async ({
  page,
}) => {
  await signInAsMember(page);
  await page.goto(TASK_PATH);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(-1),
    absoluteExpiresAt: hoursFromNow(24 * 60),
  });

  // No gesture, deliberately. The sidebar polls the unread count every 30 s while the tab is
  // visible (usePollWhileVisible), and that ordinary call is how an already-open tab finds out —
  // use-api's onUnauthorized, a different path from the guard's first-mount check, and this
  // codebase has form for one of two paths being fixed while the other stayed broken. Clicking a
  // link instead raced that poll: whichever 401 lands first unmounts the navigation, so the click
  // sometimes had no link left to hit.
  const unauthorised = await page.waitForResponse(
    (r) => r.url().includes("/api/") && r.status() === 401,
    { timeout: 45_000 }
  );
  expect(unauthorised.status()).toBe(401);

  // The path carried is where they were sitting; its exact value is pinned by the idle-expiry test
  // above, on a page load. What this one is about is that the tab acts on the 401 at all rather
  // than sitting there with a screen it can no longer refresh.
  await expect(page).toHaveURL(/\/login\?next=%2F/, { timeout: 20_000 });
  // Signed out by the expiry check, not by a row Mongo's TTL reaper had already taken
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);
});

test("where you are sent after signing in is a path on this origin, never a URL", async ({
  page,
}) => {
  // Attacker-reachable: the value rides in the query of a link to our own login page
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD, "/login?next=//example.com");
  await expect(page).toHaveURL(/\/projects$/);

  // The control beside the refusal: an ordinary path is still honoured, so the assertion above is
  // about this value and not about the parameter being ignored altogether
  await page.context().clearCookies();
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD, "/login?next=%2Fsettings%2Fsecurity");
  await expect(page).toHaveURL(/\/settings\/security$/);
});

test("the sign-in form names the throttle, which refuses the right password and only this account", async ({
  page,
  request,
}) => {
  // The number itself, once, because everything else that reads it — this file, the unit tests —
  // imports it too, so raising it to 5000 would leave every one of them green while the throttle
  // stopped bounding anything.
  expect(ANONYMOUS_ACCOUNT_ATTEMPTS).toBe(50);

  // One short of the threshold, so the next attempt is the one that trips it. Every one of these
  // is asserted 401, which is also the control: they are refusals about credentials, not a fixture
  // that was throttling from the start.
  await burnLoginAttempts(request, ANONYMOUS_ACCOUNT_ATTEMPTS - 1);

  // Through the form, because the message is the deliverable — a 429 nobody renders is a status
  // code, not an explanation
  await page.goto("/login");
  const [tripping] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
    signIn(page, MEMBER_USERNAME, WRONG_PASSWORD),
  ]);
  expect(tripping.status()).toBe(429);
  await expect(page.getByText(THROTTLED)).toBeVisible();

  // And the part that makes it a lockout rather than a slow "wrong password": the *right* one is
  // refused too. Asserted on the response rather than on the text, which is the same string as the
  // one already on screen.
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
    signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD),
  ]);
  expect(refused.status()).toBe(429);
  await expect(page.getByText(THROTTLED)).toBeVisible();
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

  // The lockout is an account's, not the instance's. This is also the positive control for the
  // line above: a session row *is* written when a login is allowed to succeed, so its absence for
  // the member means something.
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
  expect(await sessionsOf(ADMIN_ID)).toHaveLength(1);
  // Read again now that a login has been allowed to write one: the member's empty result above is
  // a measurement rather than an empty collection nobody was ever going to fill
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);
});

test("the throttle lets go once its window has lapsed", async ({ page, request }) => {
  await lockOutMember(request);

  // "Try again later" is a promise about a window (15 minutes), and no test can wait for it. The
  // counter's own `resetAt` is moved instead — the state the clock would produce — because a
  // throttle that never lets go locks everybody out permanently and every other test here passes.
  const counter = await accountCounter();
  await (await db())
    .collection("ratelimits")
    .updateOne({ _id: counter._id }, { $set: { resetAt: new Date(Date.now() - HOUR) } });

  // The state this test is about is "the window has lapsed and the document is still here". With
  // the counter gone the login would succeed for the wrong reason — the filter under test would be
  // unreachable — and a throttle that never lets anybody go would report green.
  const lapsed = await accountCounter();
  expect(lapsed.count).toBe(ANONYMOUS_ACCOUNT_ATTEMPTS);

  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("a reset link lets a locked-out account back in, and ends the sessions it may have left", async ({
  browser,
  page,
  request,
}) => {
  // Somebody signed in as this account elsewhere. Before the lockout, because a successful login
  // clears the account counter and would undo the burn below.
  const elsewhere = await browser.newContext();
  try {
    const otherDevice = await elsewhere.newPage();
    await signInFrom(otherDevice, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(otherDevice).toHaveURL(/\/projects/);
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

    // The exit BP-347 is about, and the only one somebody actually locked out can reach: changing
    // your password in Settings needs a session, which is the one thing they do not have.
    await lockOutMember(request);
    const token = await plantResetLink();

    await page.goto(`/reset?token=${token}`);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set the password" }).click();
    await expect(page.getByText("Your password is set")).toBeVisible();

    // The promise the reset screen makes, and the reason somebody who thinks their password was
    // stolen resets it at all. Nothing else in this file covers it: the account under test here
    // has been signed out of the form all along, so without the device above the assertion would
    // be satisfied by a session that never existed.
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);
    await otherDevice.reload();
    await expect(otherDevice).toHaveURL(/\/login/);

    // Asserted before the successful sign-in, because a success clears the account counter by
    // itself and would hide whether the reset had
    await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(page.getByText("Invalid credentials")).toBeVisible();

    await signIn(page, MEMBER_USERNAME, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/projects/);
  } finally {
    await elsewhere.close();
  }
});

test("changing your own password: the new one works, the old one stops, this device stays", async ({
  page,
}) => {
  await signInAsMember(page);
  const before = await onlySessionOf(MEMBER_ID);

  await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
  await expect(page.getByText("Password changed")).toBeVisible();

  // The screen promises "You stay signed in on this device". Proven by a request the server had to
  // answer authenticated, not by a URL — the sign-out here is client-side, so a URL assertion
  // matches before the guard has decided anything.
  await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);
  // And it is the same row rather than a reissued one; a silent re-login would look identical
  expect(String((await onlySessionOf(MEMBER_ID))._id)).toBe(String(before._id));

  await page.context().clearCookies();
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await expect(page.getByText("Invalid credentials")).toBeVisible();

  await signIn(page, MEMBER_USERNAME, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
});

test("the current password is what stands between a borrowed session and the account", async ({
  page,
}) => {
  await signInAsMember(page);

  await changeOwnPassword(page, WRONG_PASSWORD, NEW_PASSWORD);
  await expect(page.getByText("Current password is incorrect")).toBeVisible();

  // The refusal has to be about the current password rather than about the form: the same gesture
  // with the right one goes through
  await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
  await expect(page.getByText("Password changed")).toBeVisible();
});

test("changing your own password lifts a login lockout", async ({ browser, page, request }) => {
  // Signed in on this device before the lockout exists — the second of the two exits, and the one
  // for somebody who is locked out at the form but still holds a session elsewhere
  await signInAsMember(page);
  await lockOutMember(request);

  const lockedOut = await browser.newContext();
  try {
    const phone = await lockedOut.newPage();
    await signInFrom(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone.getByText(THROTTLED)).toBeVisible();

    await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
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
  const kept = await onlySessionOf(MEMBER_ID);

  const other = await browser.newContext();
  try {
    const phone = await other.newPage();
    await signInFrom(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone).toHaveURL(/\/projects/);
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(2);

    await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
    await expect(page.getByText("Password changed")).toBeVisible();

    await phone.reload();
    await expect(phone).toHaveURL(/\/login/);

    // Named, not counted: the revocation was aimed at the other device, and the row that survived
    // is this one's rather than whichever the query happened to reach first
    expect(String((await onlySessionOf(MEMBER_ID))._id)).toBe(String(kept._id));
    await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);
  } finally {
    await other.close();
  }
});
