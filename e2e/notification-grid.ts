import { expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { SMTP_STUB_CONTROL_URL } from "../playwright.config";
import { E2E_MONGODB_URI, PROJECT_KEY } from "./seed";

/**
 * What two specs need in common to drive the notification grid to a delivery: the mailbox the stub
 * holds, the cells a reader ticks, and the hand-over that fires `task_assigned`.
 *
 * Shared rather than copied because the comments are the load-bearing part — each helper below
 * exists in the shape it does to stop an assertion passing for the wrong reason, and a second copy
 * is a copy that can drift from the reason.
 */

export interface StubMessage {
  from: string;
  to: string[];
  data: string;
}

export async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

export async function mail(): Promise<StubMessage[]> {
  const response = await fetch(`${SMTP_STUB_CONTROL_URL}/messages`);
  return response.json();
}

export async function clearTheMailbox() {
  await fetch(`${SMTP_STUB_CONTROL_URL}/reset`, { method: "POST" });
}

/**
 * A message's body as it was written, with quoted-printable's soft line breaks and `=3D` undone.
 *
 * Anything asserted against the raw `data` is asserted against the encoder: a line over 76
 * characters is folded with a trailing `=`, which can fall inside a task key or a URL.
 */
export function bodyOf(message: StubMessage): string {
  return message.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
}

/**
 * Addresses, as setup. The seed leaves every account's `email` empty, and `createNotifications`
 * drops a recipient who has none before the grid is ever consulted — so without this the e-mail
 * column would be silent for a reason that has nothing to do with what is under test.
 */
export async function giveThemMailboxes(mailboxes: Record<string, string>) {
  const handle = await db();
  for (const [username, mailbox] of Object.entries(mailboxes)) {
    const result = await handle
      .collection("users")
      .updateOne({ username }, { $set: { email: mailbox } });
    // Asserted, because a silence cannot tell the three clauses of the mail filter apart. Without
    // an address the dispatch drops the recipient before the grid is consulted, and a negative
    // here would then be measuring a renamed constant or a changed seed order rather than a tick.
    expect(result.matchedCount, `no account named ${username} to give an address to`).toBe(1);
  }
}

/** Waits on the response rather than the toast: the next click may be another save. */
export function saved(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      /\/notifications\/?$/.test(new URL(r.url()).pathname) &&
      r.status() < 400
  );
}

/** Sets one cell of the reader's own global grid, through the screen. */
export async function setGlobalCell(page: Page, row: string, column: string, on: boolean) {
  await page.goto("/settings/notifications");
  const cell = page.getByRole("checkbox", { name: `${row} — ${column}` });
  await expect(cell).toBeVisible();
  if (on) await cell.check();
  else await cell.uncheck();

  const written = saved(page);
  await page.getByRole("button", { name: "Save" }).click();
  await written;
}

/**
 * Creates a task already assigned to somebody — the hand-over `task_assigned` fires for.
 *
 * By username rather than by the option's text: the new-task form's Assignee is a native select
 * whose options read "E2E Member (member)", and its value is the username.
 */
export async function assignANewTask(admin: Page, title: string, assignee: string) {
  await admin.goto(`/projects/${PROJECT_KEY}`);
  await admin.getByRole("button", { name: "New task" }).click();

  const modal = admin.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByLabel("Title").fill(title);
  await modal.getByLabel("Assignee").selectOption(assignee);

  const created = admin.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/tasks") &&
      r.status() < 400
  );
  await modal.getByRole("button", { name: "Create Task" }).click();
  await created;
}

/**
 * Waits until the dispatch for one task has demonstrably run for this reader.
 *
 * `createNotifications` is fire-and-forget, so a window opened when `POST /tasks` answers can close
 * before the dispatch has started — and an absence measured over it says only that the test was
 * quicker. The bell row is written inside the same pass, *before* the e-mail branch is reached
 * (`src/lib/in-app-notifications.ts`), so once it is on this reader's screen the mail decision has
 * already been taken and the window that follows is measuring the decision rather than the delay.
 *
 * Every reader here has the bell on for the row in question: it is on in the legacy default, and
 * none of these tests ever unticks In app. That is a precondition of the gate, not a detail — the
 * row is written with `inApp: shown(recipientId)` and `/notifications` hides the hidden ones, so
 * wiring this into a test that unticks In app turns it into a 30 s hang rather than a failure.
 *
 * It matches the row's **body**, which is the task title — and a freshly created assigned task can
 * produce two rows carrying it: the board feed's `task_created` is dispatched before the
 * `task_assigned` one (`task-service.ts`). Nobody in these files has a `task_created` tick, so no
 * feed row is written and the gate can only resolve on the assigned one. Give a reader that tick
 * and the gate would resolve on a row written *before* the dispatch it is supposed to be waiting
 * for, and quietly stop gating anything.
 *
 * It orders the window after the channel *decision*, which is not the same as after a delivery.
 * Every silence in these files is also preceded by a mail that did arrive, in its own test, which
 * is what covers the rest: the first send of a run pays for the transport, the certificate and the
 * handshake, and no gate on the bell can stand in for that.
 *
 * It only ever **reads** the feed. Clicking a row marks it read, and the digest is assembled from
 * unread rows — so a gate that clicked would quietly empty the mail it is a precondition for.
 */
export async function dispatchHasRun(page: Page, title: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Waits for a message addressed to one person carrying one task's title.
 *
 * The title rather than the subject: nodemailer MIME-encodes a subject, and a test that matched the
 * encoded form would be asserting the encoder. The title travels in the body as it was typed.
 */
export async function expectMailFor(address: string, title: string) {
  await expect(async () => {
    const arrived = await mail();
    expect(
      arrived.filter((m) => m.to.includes(address) && m.data.includes(title)),
      // What did arrive, so a failure says whether nothing was sent or something else was
      `no mail carrying "${title}" reached ${address}; the server holds ${JSON.stringify(
        arrived.map((m) => ({ to: m.to, subject: /Subject: (.*)/.exec(m.data)?.[1] }))
      )}`
    ).toHaveLength(1);
    // Generous, and it is the *first* message of a run that needs it: the mail path — nodemailer,
    // the template, the transport — is compiled on first use by the dev server, and that arrives
    // long after the request that asked for it has answered.
  }).toPass({ timeout: 60_000 });
}

/**
 * Absence held over a window rather than read once: the mail is sent after the request that caused
 * it has already answered, so a single read proves only that this test was quicker than the send.
 * The control in the same test is what separates "the tick decided" from "this run delivers nothing
 * to anybody".
 */
export async function expectNoMailFor(page: Page, address: string, title: string) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const arrived = await mail();
    expect(
      arrived.filter((m) => m.to.includes(address) && m.data.includes(title)),
      `mail about "${title}" reached ${address}, who had not asked for it`
    ).toHaveLength(0);
    await page.waitForTimeout(500);
  }
}
