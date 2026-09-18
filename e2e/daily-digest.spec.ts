import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BYSTANDER_PASSWORD,
  BYSTANDER_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  seed,
  seedBoardFeedBystander,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";
import { bodyOf, type StubMessage } from "./mailbox";
import {
  assignANewTask,
  clearTheMailbox,
  db,
  dispatchHasRun,
  expectMailFor,
  giveThemMailboxes,
  mail,
  setGlobalCell,
} from "./notification-grid";

/**
 * BP-605. The morning digest is the one channel nothing had ever produced. BP-465 drove the digest
 * checkbox to its effect on the *immediate* message — ticked, the reader stops being written to
 * during the day — and stopped there, because nothing a person clicks produces the mail that is
 * supposed to arrive instead. `startDigestScheduler` fires it on a timer, at an hour and in a
 * timezone read from the environment.
 *
 * So what was covered was a silence. Every part of the other half — the query that selects
 * subscribers, the `Notification` rows the message is assembled from, the unread rule, the day
 * claim that stops it going twice, the template, and a delivery through nodemailer and STARTTLS —
 * was reachable only from `digest.test.ts`, against mocked models and a mocked transport.
 *
 * The rig is in two parts, both in `playwright.config.ts`:
 *
 * - `DIGEST_TICK_MS` is pinned to a day. The scheduler has in fact been running for the whole of
 *   every e2e run since BP-465 configured mail, at the 5-minute default, and nothing noticed —
 *   the digest carries each row's own title, not the task title the suite's mail assertions match
 *   on. This file is the one that cannot live with it: a background tick claims the day in
 *   `lastDigestDay` before the tick asked for here, which then finds nobody to write to. Measured
 *   both ways at a 3-second tick.
 * - `DIGEST_HOUR` is midnight, so a tick asked for at any hour is due. The default is 07:00
 *   Europe/Warsaw, and `dueDigestDay` answers null before it — which would have made this file
 *   pass or fail by the clock on the wall.
 *
 * The tick itself is asked for over HTTP (`POST /api/e2e/digest`), which is what puts it inside the
 * dev server: `@/lib/email` captures `SMTP_*` at module load, and importing the digest into this
 * process would arm real mail for every other spec sharing the Playwright worker.
 *
 * Every gesture is driven on the screen — the grid cell, the digest box, the assignment, and the
 * row the reader opens. Three things are not, and each is setup rather than subject: the clock,
 * the mailbox an account is given (a person sets that on /profile, which `email-on-account.spec.ts`
 * drives), and the task number a key is read back from.
 */

const MEMBER_MAILBOX = "member@e2e.invalid";
const BYSTANDER_MAILBOX = "bystander@e2e.invalid";
const ASSIGNED_ROW = "A task is assigned to you";
const DIGEST_BOX = "Collect the e-mail column into one daily digest";
/** `renderEmail`'s kicker for this message, and the one thing only the digest carries. */
const DIGEST_KICKER = "Daily digest";

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

/**
 * Asks the scheduler to run once, and answers with what it says it sent.
 *
 * The count is the tick's own, not a delivery count — `sendEmail` swallows a transport failure and
 * answers `false`, which `digestTick` does not read. So it is asserted alongside what arrived at
 * the mail server, never instead of it.
 */
async function runTheDigest(request: APIRequestContext): Promise<number> {
  const response = await request.post("/api/e2e/digest");
  expect(
    response.status(),
    "the e2e digest trigger is not mounted: it needs E2E=1 and a non-production build"
  ).toBe(200);
  return (await response.json()).sent;
}

/** What the stub holds for one reader that is a digest, bodies already unfolded. */
async function digestsFor(address: string): Promise<string[]> {
  const arrived: StubMessage[] = await mail();
  return arrived
    .filter((m) => m.to.includes(address))
    .map(bodyOf)
    .filter((body) => body.includes(DIGEST_KICKER));
}

/**
 * The key the board gave a task, read back rather than counted on.
 *
 * The digest's lines are labelled with the task key and carry the notification's own title — the
 * task's title is not in the message at all — so the key is the only thing that says which task a
 * line is about. `taskCounter` is per project and the seed already spends several numbers, so
 * guessing one here would pin this file to the seed's current size.
 *
 * Only the number is read back; the project part is this suite's one board, and the lookup is by
 * title across the collection because there is no second board for a title to collide on.
 */
async function keyOf(title: string): Promise<string> {
  const handle = await db();
  const task = await handle.collection("tasks").findOne({ title });
  expect(task, `no task titled "${title}" on the board`).not.toBeNull();
  return `${PROJECT_KEY}-${task!.taskNumber}`;
}

/** A key on a line of its own terms: `TP-7` must not be satisfied by `TP-70`. */
const mentions = (body: string, key: string) => new RegExp(`${key}(?![0-9])`).test(body);

test.beforeEach(async () => {
  await seed();
  await seedBoardFeedBystander();
  await giveThemMailboxes({
    [MEMBER_USERNAME]: MEMBER_MAILBOX,
    [BYSTANDER_USERNAME]: BYSTANDER_MAILBOX,
  });
  await clearTheMailbox();
});

test("the morning message carries the day the reader banked, and reaches only the reader who asked", async ({
  browser,
  request,
}) => {
  const memberContext = await browser.newContext();
  const bystanderContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const bystander = await bystanderContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(bystander, BYSTANDER_USERNAME, BYSTANDER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

  // The control, and it is what makes the bystander's silence below mean anything: both readers ask
  // for exactly the same mail, on the same board, from the same actor. Only the digest box differs.
  await test.step("both ask for mail when a task is assigned to them", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", true);
    await setGlobalCell(bystander, ASSIGNED_ROW, "E-mail", true);
  });

  await test.step("the member collects theirs into a digest instead", async () => {
    const stored = member.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/api/users/me") && r.status() < 400
    );
    await member.getByLabel(DIGEST_BOX).check();
    await stored;
  });

  // Neither title contains the other. `dispatchHasRun` matches a row by substring, so a pair like
  // "Banked" / "Banked as well" would let the second row satisfy the gate for the first — and the
  // gate for a row that has not been written yet is no gate (BP-605 review).
  const morning = ["Banked for the morning", "Left unread until sunrise"];
  const immediate = "Sent to the bystander straight away";
  await test.step("a day happens on the board", async () => {
    await assignANewTask(admin, morning[0], MEMBER_USERNAME);
    await assignANewTask(admin, morning[1], MEMBER_USERNAME);
    await assignANewTask(admin, immediate, BYSTANDER_USERNAME);
  });

  // Both halves of the precondition. The bystander's mail is the run's proof that this transport
  // delivers at all — without it, a digest that never arrived would be indistinguishable from a
  // mail server that was never reachable. The two bell rows are the proof that the dispatch ran for
  // the member, which is what the digest is assembled from.
  await test.step("the immediate message goes out, and the member's day is recorded", async () => {
    await expectMailFor(BYSTANDER_MAILBOX, immediate);
    await dispatchHasRun(member, morning[0]);
    await dispatchHasRun(member, morning[1]);
  });

  const keys = [await keyOf(morning[0]), await keyOf(morning[1])];

  await test.step("the scheduler runs, and writes to the one subscriber", async () => {
    expect(await runTheDigest(request)).toBe(1);
  });

  await test.step("the mail is the member's own day, in one message", async () => {
    await expect(async () => {
      const digests = await digestsFor(MEMBER_MAILBOX);
      expect(digests, "the member was sent no digest").toHaveLength(1);

      const [body] = digests;
      // Counted, not merely non-empty: "2 updates" is the number the subject and the heading both
      // print, and the line that would be wrong if the query stopped narrowing to this reader. The
      // boundary is not pedantry — a bare `toContain` here is also satisfied by "12 updates".
      expect(body).toMatch(/(^|[^0-9])2 updates on your tasks/);
      for (const key of keys) {
        expect(mentions(body, key), `${key} is not in the digest`).toBe(true);
        // The line as the text part composes it: the key labels the row, so `lineFor` takes the
        // key off the front of the stored title rather than printing "TP-8: TP-8 assigned to you"
        expect(body).toContain(`${key}: assigned to you`);
      }
      // Assembled from the stored rows, each of which keeps the link its own mail would have had
      expect(body).toContain(`/projects/${PROJECT_KEY}/tasks/`);
    }).toPass({ timeout: 30_000 });
  });

  // Read once rather than held over a window, and that is sound here where it would not be after an
  // ordinary request. `digestTick` awaits every send inside the one POST above, and the stub files
  // a message before it answers 250 (`e2e/smtp-stub.mjs`) — so by the time the trigger has
  // answered, everything this tick was ever going to deliver is already on the server. Nothing is
  // in flight to wait for, and an absence read now is the tick's own decision.
  await test.step("and the reader who wanted their mail as it happened gets no digest", async () => {
    expect(await digestsFor(BYSTANDER_MAILBOX)).toHaveLength(0);
  });

  // `lastDigestDay`, claimed before the send. A scheduler ticks all day; a reader is written to
  // once. This is the assertion the claim exists for, and nothing else in the suite makes it.
  await test.step("a second tick the same day sends nothing more", async () => {
    expect(await runTheDigest(request)).toBe(0);
    expect(await digestsFor(MEMBER_MAILBOX)).toHaveLength(1);
  });

  await memberContext.close();
  await bystanderContext.close();
  await adminContext.close();
});

test("a row the reader has already opened is not repeated in the morning", async ({
  browser,
  request,
}) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

  await test.step("the member takes their mail as a digest", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", true);
    const stored = member.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/api/users/me") && r.status() < 400
    );
    await member.getByLabel(DIGEST_BOX).check();
    await stored;
  });

  const alreadySeen = "Opened in the bell during the day";
  const stillWaiting = "Never opened at all";
  await test.step("two tasks are handed to them", async () => {
    await assignANewTask(admin, alreadySeen, MEMBER_USERNAME);
    await assignANewTask(admin, stillWaiting, MEMBER_USERNAME);
    await dispatchHasRun(member, alreadySeen);
    await dispatchHasRun(member, stillWaiting);
  });

  await test.step("the member opens one of them in their feed", async () => {
    await member.goto("/notifications");
    const read = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().includes("/api/notifications/read") &&
        r.status() < 400
    );
    // By the row's body, which is the task title — the row's own title is the key plus "assigned
    // to you", which both rows carry
    await member.getByText(alreadySeen).first().click();
    await read;
  });

  const seen = await keyOf(alreadySeen);
  const waiting = await keyOf(stillWaiting);

  await test.step("the morning message is only what they have not seen", async () => {
    expect(await runTheDigest(request)).toBe(1);

    await expect(async () => {
      const digests = await digestsFor(MEMBER_MAILBOX);
      expect(digests, "the member was sent no digest").toHaveLength(1);

      const [body] = digests;
      expect(mentions(body, waiting), `${waiting} should be in the digest`).toBe(true);
      // The rule the digest exists for: a message that repeats what the reader has already read
      // teaches them to skip it
      expect(mentions(body, seen), `${seen} was read in the bell and still mailed`).toBe(false);
      // And the count is the survivors, not the day's rows — the heading is printed from it
      expect(body).toContain("1 update on your tasks");
    }).toPass({ timeout: 30_000 });
  });

  await memberContext.close();
  await adminContext.close();
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
