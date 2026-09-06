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
  seedWithoutSessions,
} from "./seed";

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

async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function expireSession(
  userId: mongoose.Types.ObjectId,
  when: { expiresAt: Date; absoluteExpiresAt: Date }
) {
  const handle = await db();
  const result = await handle.collection("sessions").updateOne({ user: userId }, { $set: when });
  expect(result.matchedCount, "expected exactly one session row to expire").toBe(1);
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR);

async function accountCounter() {
  const rows = (await (await db()).collection("ratelimits").find({}).toArray()).filter(
    (row) =>
      String(row._id).startsWith("login:") && !String(row._id).startsWith("login:source:")
  );
  expect(rows, "expected exactly one account counter").toHaveLength(1);
  return rows[0];
}

async function burnLoginAttempts(request: APIRequestContext, attempts: number) {
  const batch = 8;
  for (let sent = 0; sent < attempts; sent += batch) {
    const answers = await Promise.all(
      Array.from({ length: Math.min(batch, attempts - sent) }, () =>
        request.post("/api/auth/login", {
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

async function lockOutMember(request: APIRequestContext) {
  await burnLoginAttempts(request, ANONYMOUS_ACCOUNT_ATTEMPTS - 1);
  const tripping = await request.post("/api/auth/login", {
    headers: SAME_ORIGIN,
    data: { username: MEMBER_USERNAME, password: WRONG_PASSWORD },
  });
  expect(tripping.status(), await tripping.text()).toBe(429);
}

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
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password").fill(next);
  await page.getByRole("button", { name: "Change password" }).click();
}

async function refusedAt(page: Page, path: string) {
  const [me] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/me") && r.request().method() === "GET"
    ),
    page.goto(path),
  ]);
  expect(me.status()).toBe(401);
}

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
  await seedWithoutSessions();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("Logout ends the session on the server, not only in the tab", async ({ page }) => {
  await signInAsMember(page);
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

  await hideDevOverlay(page);
  await page.getByRole("button", { name: /E2E Member/ }).click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL(/\/login/);
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

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

  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(-1),
    absoluteExpiresAt: hoursFromNow(24 * 60),
  });

  await refusedAt(page, TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);

  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);

  await expect(page).toHaveURL(new RegExp(`${TASK_PATH}$`));
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
});

test("a session past its absolute cap is refused even though the idle window is live", async ({
  page,
}) => {
  await signInAsMember(page);

  await page.goto(TASK_PATH);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await expireSession(MEMBER_ID, {
    expiresAt: hoursFromNow(24 * 30),
    absoluteExpiresAt: hoursFromNow(-1),
  });

  await refusedAt(page, TASK_PATH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(TASK_PATH)}`);
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);
});

test("a live session's idle window slides forward as it is used, never past the absolute cap", async ({
  page,
}) => {
  await signInAsMember(page);

  const distantCap = hoursFromNow(24 * 60);
  await expireSession(MEMBER_ID, { expiresAt: hoursFromNow(1), absoluteExpiresAt: distantCap });

  await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);

  const slid = await onlySessionOf(MEMBER_ID);
  expect(new Date(slid.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
  expect(new Date(slid.absoluteExpiresAt as Date).getTime()).toBe(distantCap.getTime());

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

  const unauthorised = await page.waitForResponse(
    (r) => r.url().includes("/api/") && r.status() === 401,
    { timeout: 45_000 }
  );
  expect(unauthorised.status()).toBe(401);

  await expect(page).toHaveURL(/\/login\?next=%2F/, { timeout: 20_000 });
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);
});

test("where you are sent after signing in is a path on this origin, never a URL", async ({
  page,
}) => {
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD, "/login?next=//example.com");
  await expect(page).toHaveURL(/\/projects$/);

  await page.context().clearCookies();
  await signInFrom(page, MEMBER_USERNAME, MEMBER_PASSWORD, "/login?next=%2Fsettings%2Fsecurity");
  await expect(page).toHaveURL(/\/settings\/security$/);
});

test("the sign-in form names the throttle, which refuses the right password and only this account", async ({
  page,
  request,
}) => {
  expect(ANONYMOUS_ACCOUNT_ATTEMPTS).toBe(50);

  await burnLoginAttempts(request, ANONYMOUS_ACCOUNT_ATTEMPTS - 1);

  await page.goto("/login");
  const [tripping] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
    signIn(page, MEMBER_USERNAME, WRONG_PASSWORD),
  ]);
  expect(tripping.status()).toBe(429);
  await expect(page.getByText(THROTTLED)).toBeVisible();

  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
    signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD),
  ]);
  expect(refused.status()).toBe(429);
  await expect(page.getByText(THROTTLED)).toBeVisible();
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/projects/);
  expect(await sessionsOf(ADMIN_ID)).toHaveLength(1);
  expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);
});

test("the throttle lets go once its window has lapsed", async ({ page, request }) => {
  await lockOutMember(request);

  const counter = await accountCounter();
  await (await db())
    .collection("ratelimits")
    .updateOne({ _id: counter._id }, { $set: { resetAt: new Date(Date.now() - HOUR) } });

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
  const elsewhere = await browser.newContext();
  try {
    const otherDevice = await elsewhere.newPage();
    await signInFrom(otherDevice, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(otherDevice).toHaveURL(/\/projects/);
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

    await lockOutMember(request);
    const token = await plantResetLink();

    await page.goto(`/reset?token=${token}`);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set the password" }).click();
    await expect(page.getByText("Your password is set")).toBeVisible();

    expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);
    await otherDevice.reload();
    await expect(otherDevice).toHaveURL(/\/login/);

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

  await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);
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

  await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
  await expect(page.getByText("Password changed")).toBeVisible();
});

test("changing your own password lifts a login lockout", async ({ browser, page, request }) => {
  await signInAsMember(page);
  await lockOutMember(request);

  const lockedOut = await browser.newContext();
  try {
    const phone = await lockedOut.newPage();
    await signInFrom(phone, MEMBER_USERNAME, MEMBER_PASSWORD);
    await expect(phone.getByText(THROTTLED)).toBeVisible();

    await changeOwnPassword(page, MEMBER_PASSWORD, NEW_PASSWORD);
    await expect(page.getByText("Password changed")).toBeVisible();

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

    expect(String((await onlySessionOf(MEMBER_ID))._id)).toBe(String(kept._id));
    await loadsAuthenticated(page, `/projects/${PROJECT_KEY}`);
  } finally {
    await other.close();
  }
});
