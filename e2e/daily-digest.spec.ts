import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BYSTANDER_PASSWORD,
  BYSTANDER_USERNAME,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_NUMBER,
  seed,
  seedBoardFeedBystander,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";
import { bodyOf, refuseMailFor, stopRefusing, type StubMessage } from "./mailbox";
import {
  assignANewTask,
  clearTheMailbox,
  db,
  dispatchHasRun,
  expectMailFor,
  giveThemMailboxes,
  mail,
  saved,
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
 * dev server. Calling `digestTick` from here instead would not send anything: this process has no
 * `SMTP_*` — they are set on the dev server — so `isEmailConfigured()` is false and the tick
 * returns 0 before it reads a thing. Giving this process a mail server to fix that is the part to
 * avoid: `@/lib/email` captures `SMTP_*` at module load and one worker shares its registry across
 * every spec in the group — and `claim-ownership` and `worker-controls` are in this one, driving
 * `@/lib/task-service` in the runner. They would start delivering real mail from tests that never
 * asked for any. (`column-roles` drives it too, from `board`, where a separate worker would carry
 * the same arming.)
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
 * Asks the scheduler to run once, and answers how many digests it delivered.
 *
 * Deliveries, since BP-659: the count used to include a message the mail server had refused,
 * because `sendEmail` answers `false` rather than throwing and nothing read the answer. It is still
 * asserted alongside what arrived at the stub rather than instead of it — a count cannot say what
 * was in the message.
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

/**
 * The digest's plain-text part as lines, quoted-printable undone in full. `bodyOf` only reverses
 * soft breaks and `=3D`, which leaves the em dash an unresolved row is labelled with as
 * `=E2=80=94` and a whole-line match on it impossible.
 */
function linesOf(body: string): string[] {
  const bytes = body.replace(/=([0-9A-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return Buffer.from(bytes, "latin1").toString("utf8").split(/\r?\n/);
}

/** One digest row as the text part composes it, `key: title`, and nothing else on the line. */
const row = (line: string) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** Every line of the text part that is a digest row: a task key, or an unresolved row's dash. */
const rowsIn = (lines: string[]) => lines.filter((l) => /^([A-Z]+-\d+|—): /.test(l));

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
        // The line as the text part composes it, as a whole line: `lineFor` takes the key off the
        // front of the stored title, and "TP-8: TP-8 assigned to you" contains the substring too
        expect(linesOf(body)).toContainEqual(expect.stringMatching(row(`${key}: assigned to you`)));
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

/**
 * BP-697. The test above asserts one row shape out of the six a digest can carry, and asserted it
 * as a substring — which "TP-2: TP-2 assigned to you", the doubled key BP-692 fixed, satisfies.
 * Each notification type is produced here by the gesture that produces it, and every row is
 * matched as a whole line of the text part, so a key printed twice fails wherever it sits.
 *
 * Three rows are not affected by `lineFor`'s key strip at all, and that is by design rather than a
 * gap in this test: the board feed's key sits mid-sentence ("New task TP-9 in …"), task_linked is
 * exempt by type because its sentence names two tasks, and an unresolved row has no key to strip.
 *
 * The admin reads the digest and the member does everything, because the one row no gesture can
 * produce — a project that no longer resolves — is planted, and only an instance admin's digest
 * is not narrowed to boards that still exist.
 */
test("every kind of row reaches the morning message as a line of its own", async ({
  browser,
  request,
}) => {
  const ADMIN_MAILBOX = "admin@e2e.invalid";
  await giveThemMailboxes({ [ADMIN_USERNAME]: ADMIN_MAILBOX });

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);

  await test.step("the admin takes every row by mail, collected into a digest", async () => {
    await admin.goto("/settings/notifications");
    for (const label of [
      ASSIGNED_ROW,
      "Somebody mentions you",
      "A task you follow changes column",
      "A task you follow gets a comment",
      "A task you follow gains or loses a dependency",
      "Anybody creates a task on a board",
    ]) {
      await admin.getByRole("checkbox", { name: `${label} — E-mail` }).check();
    }
    const written = saved(admin);
    await admin.getByRole("button", { name: "Save" }).click();
    await written;

    const stored = admin.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/api/users/me") && r.status() < 400
    );
    await admin.getByLabel(DIGEST_BOX).check();
    await stored;
  });

  const title = "Every shape of row on one task";
  await test.step("the member creates a task and hands it to the admin", async () => {
    await assignANewTask(member, title, ADMIN_USERNAME);
  });
  const key = await keyOf(title);
  const taskUrl = `/projects/${PROJECT_KEY}/tasks/${key.split("-")[1]}`;

  await test.step("moves it", async () => {
    await member.goto(taskUrl);
    const moved = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.status() < 400 &&
        /\/tasks\/.*\/status$/.test(new URL(r.url()).pathname)
    );
    await member.getByRole("combobox", { name: "Status" }).click();
    await member.getByRole("option", { name: "In Progress" }).click();
    await moved;
  });

  const comment = async (text: string) => {
    const posted = member.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/tasks\/[^/]+\/comments$/.test(new URL(r.url()).pathname) &&
        r.status() < 400
    );
    await member.getByPlaceholder("Write a comment, @mention someone…").fill(text);
    await member.getByRole("button", { name: "Comment" }).click();
    await posted;
  };
  await test.step("comments on it, then mentions the admin", async () => {
    await comment("Picked this up for the morning");
    await comment(`@${ADMIN_USERNAME} one more for your list`);
  });

  const other = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
  await test.step("and links it to another task", async () => {
    await member.getByRole("button", { name: "+ Add dependency" }).click();
    await member.getByLabel("Link type").selectOption("relates");
    await member.getByLabel("Search tasks to link").fill(other);
    const linked = member.waitForResponse(
      (r) => r.request().method() === "POST" && /\/links$/.test(new URL(r.url()).pathname)
    );
    await member.getByRole("button", { name: new RegExp(other) }).click();
    expect((await linked).status()).toBe(200);
  });

  const handle = await db();
  const task = await handle.collection("tasks").findOne({ title });
  // Setup, not subject: no gesture leaves a row pointing at a project that no longer resolves, so
  // one is written the way a writer would have spelt it — `taskKeyOf` gives `#42` without a key
  const unresolved = `#${task!.taskNumber} assigned to you`;
  await handle.collection("notifications").insertOne({
    recipient: ADMIN_ID,
    type: "task_assigned",
    task: task!._id,
    project: new mongoose.Types.ObjectId(),
    actor: MEMBER_ID,
    title: unresolved,
    body: title,
    read: false,
    inApp: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const expected = [
    `${key}: New task ${key} in ${PROJECT_NAME}`,
    `${key}: assigned to you`,
    `${key}: moved to In Progress`,
    `${key}: New comment on`,
    `${key}: ${MEMBER_USERNAME} mentioned you in`,
    `${key}: ${MEMBER_USERNAME} linked ${key} to ${other}`,
    `—: ${unresolved}`,
  ];

  // Each dispatch is fire-and-forget; the rows are what the digest is built from
  await expect
    .poll(() => handle.collection("notifications").countDocuments({ recipient: ADMIN_ID }), {
      timeout: 30_000,
    })
    .toBe(expected.length);

  await test.step("the scheduler runs, and writes to the admin", async () => {
    expect(await runTheDigest(request)).toBe(1);
  });

  let lines: string[] = [];
  await expect(async () => {
    const digests = await digestsFor(ADMIN_MAILBOX);
    expect(digests, "the admin was sent no digest").toHaveLength(1);
    lines = linesOf(digests[0]);
  }).toPass({ timeout: 30_000 });

  // Soft, so one run names every shape that broke rather than the first
  for (const line of expected) {
    expect.soft(lines, `no whole line "${line}"`).toContainEqual(expect.stringMatching(row(line)));
  }
  // And nothing besides: a row printed twice, or one this list forgot, is a line too many
  expect(rowsIn(lines).sort()).toEqual([...expected].sort());
  expect(lines).toContainEqual(expect.stringMatching(/(^|[^0-9])7 updates on your tasks/));

  await adminContext.close();
  await memberContext.close();
});

/**
 * BP-659. The day is claimed in `lastDigestDay` before the message is built, so that a crash costs
 * one digest rather than sending it from every instance at once. Everything that was not a crash
 * kept that claim and ended the reader's day in silence: `sendEmail` answers `false` for a refused
 * send rather than throwing, nothing read the answer, and by the next morning those rows had fallen
 * out of the digest's 24-hour window and were never mailed at all.
 *
 * Driven for real rather than reasoned about: the stub answers 550 at end-of-DATA for one address
 * (BP-469), which is a refusal from nodemailer's point of view and not a fixture.
 */
test("a refused delivery is tried again at the next tick, not lost with the day", async ({
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

  const banked = "Waiting while the mail server says no";
  await test.step("a task is handed to them, and their mail server stops taking mail", async () => {
    await assignANewTask(admin, banked, MEMBER_USERNAME);
    await dispatchHasRun(member, banked);
    await refuseMailFor(MEMBER_MAILBOX);
  });

  await test.step("the tick delivers nothing, and says so", async () => {
    // 0, not 1: the count is deliveries. Against the old code this line reads 1 — the refusal was
    // counted as a send — and the mailbox below is empty either way, which is what made the
    // failure silent.
    expect(await runTheDigest(request)).toBe(0);
    expect(await digestsFor(MEMBER_MAILBOX)).toHaveLength(0);
  });

  await test.step("the mail server recovers", async () => {
    await stopRefusing();
  });

  const key = await keyOf(banked);
  await test.step("and the next tick sends the day the first one could not", async () => {
    // The whole ticket in one line. The day was claimed by the tick that failed, so against the old
    // code this answers 0 for ever: the reader is passed over until midnight, and tomorrow's
    // 24-hour window no longer reaches these rows.
    expect(await runTheDigest(request)).toBe(1);

    await expect(async () => {
      const digests = await digestsFor(MEMBER_MAILBOX);
      expect(digests, "the retry delivered nothing").toHaveLength(1);
      expect(mentions(digests[0], key), `${key} is not in the retried digest`).toBe(true);
    }).toPass({ timeout: 30_000 });
  });

  await memberContext.close();
  await adminContext.close();
});

test.afterAll(async () => {
  // Cancelled here as well as in the test that arms it: a refusal that outlives this file lands on
  // whichever spec sends the next message, and nothing would say why it failed.
  //
  // In a `finally`, the way `mail-test-send.spec.ts` guards the same pair: `stopRefusing` asserts
  // what the stub reports back, so it can throw — and a connection left open outlives the worker.
  try {
    await stopRefusing();
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
});
