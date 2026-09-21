import { test, expect, type Page } from "@playwright/test";
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
import {
  assignANewTask,
  clearTheMailbox,
  db,
  dispatchHasRun,
  expectMailFor,
  expectNoMailFor,
  giveThemMailboxes,
  saved,
  setGlobalCell,
} from "./notification-grid";

/**
 * BP-465. The notification grid is five events × three channels × two scopes, and until this file
 * exactly one of those thirty states was driven from a browser to an observed delivery — the one in
 * `board-feed-notifications.spec.ts`. Everything else was asserted at the legacy default grid, or
 * planted in Mongo, which leaves the question this screen exists to answer untested: does *ticking*
 * decide what arrives.
 *
 * So every assertion here starts at a checkbox a person clicks and ends at a message a stub mail
 * server received, or at a row in somebody else's browser. The e-mail column is the one that can
 * carry that end to end — `e2e/smtp-stub.mjs` is a real SMTP peer, so the message goes through
 * nodemailer, STARTTLS, AUTH and the production template.
 *
 * **The chat column's deliveries are received in `outbound-delivery.spec.ts`** (BP-696). What is
 * driven here is storage: the connection saved through its own form, and the `"__kept__"` sentinel
 * that decides whether a stored webhook survives the next save.
 */

const MEMBER_MAILBOX = "member@e2e.invalid";
const BYSTANDER_MAILBOX = "bystander@e2e.invalid";
const ASSIGNED_ROW = "A task is assigned to you";
const MOVED_ROW = "A task you follow changes column";

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

test.beforeEach(async () => {
  await seed();
  await seedBoardFeedBystander();
  await giveThemMailboxes({
    [MEMBER_USERNAME]: MEMBER_MAILBOX,
    [BYSTANDER_USERNAME]: BYSTANDER_MAILBOX,
  });
  await clearTheMailbox();
});

test("a ticked e-mail cell delivers, an unticked one does not, and unticking stops it", async ({
  browser,
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

  await test.step("the member asks for mail when a task is assigned to them", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", true);
  });

  // The control, and it is the whole test: the bystander is handed the same event, by the same
  // actor, on the same board, in the same run. Only the tick differs.
  await test.step("the bystander leaves the same cell alone", async () => {
    await bystander.goto("/settings/notifications");
    await expect(
      bystander.getByRole("checkbox", { name: `${ASSIGNED_ROW} — E-mail` })
    ).not.toBeChecked();
  });

  const wanted = "Mail because the cell was ticked";
  const unwanted = "No mail because the cell was not";

  await test.step("a task assigned to each of them", async () => {
    await assignANewTask(admin, wanted, MEMBER_USERNAME);
    await assignANewTask(admin, unwanted, BYSTANDER_USERNAME);
  });

  await test.step("only the one who ticked is written to", async () => {
    await expectMailFor(MEMBER_MAILBOX, wanted);
    await dispatchHasRun(bystander, unwanted);
    await expectNoMailFor(bystander, BYSTANDER_MAILBOX, unwanted);
  });

  // The other direction, which nothing proved before: every earlier assertion ran at the default
  // grid, so `resolveChannels` could have stopped being consulted on the global grid entirely.
  await test.step("the member unticks the cell again", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", false);
  });

  const afterUnticking = "Nothing after the cell was cleared";
  await test.step("the next assignment writes to nobody", async () => {
    await assignANewTask(admin, afterUnticking, MEMBER_USERNAME);
    await dispatchHasRun(member, afterUnticking);
    await expectNoMailFor(member, MEMBER_MAILBOX, afterUnticking);
  });

  await memberContext.close();
  await bystanderContext.close();
  await adminContext.close();
});

test("the digest holds the immediate message back, and only for the reader who asked", async ({
  browser,
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

  // Both ask for the same mail. The only difference between them is the digest box, which is what
  // makes the silence below attributable to it — the grid says "send" for both.
  await test.step("both ask for mail on assignment", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", true);
    await setGlobalCell(bystander, ASSIGNED_ROW, "E-mail", true);
  });

  await test.step("the member collects theirs into a digest instead", async () => {
    const stored = member.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/api/users/me") && r.status() < 400
    );
    await member.getByLabel("Collect the e-mail column into one daily digest").check();
    await stored;
    await member.reload();
    await expect(
      member.getByLabel("Collect the e-mail column into one daily digest")
    ).toBeChecked();
  });

  const heldBack = "Held for the morning digest";
  const sentNow = "Sent immediately as usual";

  await test.step("a task for each of them", async () => {
    await assignANewTask(admin, heldBack, MEMBER_USERNAME);
    await assignANewTask(admin, sentNow, BYSTANDER_USERNAME);
  });

  // The row is written whatever the mail did — the morning message is assembled from these
  // documents, which is why the bell hides rows rather than skipping the write. Asserted before
  // the silence rather than after it, because it is also what proves the dispatch ran at all.
  await test.step("the event is still recorded for the morning", async () => {
    await dispatchHasRun(member, heldBack);
  });

  await test.step("the digest subscriber is not written to, the other is", async () => {
    await expectMailFor(BYSTANDER_MAILBOX, sentNow);
    await expectNoMailFor(member, MEMBER_MAILBOX, heldBack);
  });

  await memberContext.close();
  await bystanderContext.close();
  await adminContext.close();
});

test("a project override mutes one board, and turning it off gives the global grid back", async ({
  browser,
}) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

  await test.step("mail on assignment, everywhere", async () => {
    await setGlobalCell(member, ASSIGNED_ROW, "E-mail", true);
  });

  const projectNotifications = async () => {
    await member.goto(`/projects/${PROJECT_KEY}/settings`);
    await member.getByRole("button", { name: "Notifications", exact: true }).first().click();
  };

  // Before the mute, so the silence after it is a change rather than a state — and so the transport
  // has demonstrably delivered to this mailbox before anything is measured by its absence. Without
  // it the test's only delivered mail is the one at the very end, and running this test on its own
  // (`-g`, `--last-failed`, or any future reordering) leaves the `muted` negative measured against
  // a transport that has never sent anything: it then passes with the `uncheck()` below deleted.
  const beforeTheMute = "Delivered here until the board is muted";
  await test.step("an assignment on this board writes, while the global grid is in force", async () => {
    await assignANewTask(admin, beforeTheMute, MEMBER_USERNAME);
    await expectMailFor(MEMBER_MAILBOX, beforeTheMute);
  });

  await test.step("but not on this board", async () => {
    await projectNotifications();

    // Before the switch, not after: this screen renders its grid from the reader's global settings
    // as soon as the section is open, and the override is seeded from whatever that grid holds at
    // the moment it is turned on. Ticking it while the read was still in flight seeded the board
    // from an empty matrix — a mute this test would then have credited to its own click.
    const beforehand = member.getByRole("checkbox", { name: `${ASSIGNED_ROW} — E-mail` });
    await expect(beforehand).toBeChecked();
    await expect(beforehand).toBeDisabled();

    const override = member.waitForResponse(
      (r) => r.request().method() === "PUT" && /\/notifications\//.test(new URL(r.url()).pathname)
    );
    await member.getByLabel("Use my own settings for this project").check();
    await override;

    // Seeded from the global grid, so it arrives ticked and enabled — this is the click that
    // mutes the board
    const cell = member.getByRole("checkbox", { name: `${ASSIGNED_ROW} — E-mail` });
    await expect(cell).toBeEnabled();
    await expect(cell).toBeChecked();
    await cell.uncheck();

    const written = member.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        /\/notifications\//.test(new URL(r.url()).pathname) &&
        r.status() < 400
    );
    await member.getByRole("button", { name: "Save" }).click();
    await written;
  });

  const muted = "Muted by this board's own grid";
  await test.step("so an assignment here says nothing", async () => {
    await assignANewTask(admin, muted, MEMBER_USERNAME);
    await dispatchHasRun(member, muted);
    await expectNoMailFor(member, MEMBER_MAILBOX, muted);
  });

  // The DELETE half, which nothing covered: it also restores the global matrix on screen
  // optimistically, so a failure leaves somebody pinned to a grid the screen says they left.
  await test.step("the member stops using their own settings for this board", async () => {
    await projectNotifications();
    const removed = member.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        /\/notifications\//.test(new URL(r.url()).pathname) &&
        r.status() < 400
    );
    await member.getByLabel("Use my own settings for this project").uncheck();
    await removed;

    await member.reload();
    await member.getByRole("button", { name: "Notifications", exact: true }).first().click();
    await expect(member.getByLabel("Use my own settings for this project")).not.toBeChecked();
  });

  const restored = "The global grid again";
  await test.step("and the global grid delivers here once more", async () => {
    await assignANewTask(admin, restored, MEMBER_USERNAME);
    await expectMailFor(MEMBER_MAILBOX, restored);
  });

  await memberContext.close();
  await adminContext.close();
});

test("a move the reader follows is read in their own browser, not only through the API", async ({
  browser,
}) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

  await test.step("the member asks to hear about moves, in the bell and by mail", async () => {
    await setGlobalCell(member, MOVED_ROW, "In app", true);
    await setGlobalCell(member, MOVED_ROW, "E-mail", true);
  });

  const followed = "A task the member is assigned and follows";
  await test.step("and is given a task, which makes them its assignee", async () => {
    await assignANewTask(admin, followed, MEMBER_USERNAME);
  });

  await test.step("the admin moves it", async () => {
    await admin.goto(`/projects/${PROJECT_KEY}`);
    const card = admin.getByText(followed).first();
    await expect(card).toBeVisible();
    await card.click();

    const moved = admin.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.status() < 400 && /\/tasks\/.*\/status$/.test(new URL(r.url()).pathname)
    );
    await admin.getByRole("combobox", { name: "Status" }).click();
    await admin.getByRole("option", { name: "In Progress" }).click();
    await moved;
  });

  // The UI-vs-API seam: `task-detail.spec.ts` polls `/api/notifications` with a Bearer for this
  // row, which proves the write and nothing about the screen the reader is looking at.
  await test.step("the row is in the member's own feed", async () => {
    await expect(async () => {
      await member.goto("/notifications");
      await expect(member.getByText(/moved to In Progress/).first()).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  await test.step("and the same move is in their mailbox", async () => {
    await expectMailFor(MEMBER_MAILBOX, followed);
  });

  await memberContext.close();
  await adminContext.close();
});

test("a personal chat connection is saved through its own form and survives the next save", async ({
  page,
}) => {
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto("/settings/notifications");

  // A tick with nothing connected delivers nowhere, so the column is held shut until there is one
  await expect(page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` })).toBeDisabled();

  await test.step("the member connects Slack", async () => {
    await page.getByRole("button", { name: "slack" }).click();

    // Filled once and read back once. This used to retry, because a superseded read could unmount
    // the field mid-fill and the retry was the only way past it; that is fixed in the page itself
    // (BP-465), so a discarded fill is a regression this test should report rather than absorb.
    const address = page.getByPlaceholder("https://hooks.slack.com/services/...");
    await address.fill("https://hooks.slack.com/services/E2E/CONNECTION/one");
    await expect(address).toHaveValue("https://hooks.slack.com/services/E2E/CONNECTION/one");

    const written = saved(page);
    await page.getByRole("button", { name: "Save" }).click();
    await written;
  });

  await test.step("the screen says there is one, without ever showing it back", async () => {
    await page.reload();
    await expect(
      page.getByPlaceholder("A webhook is stored — type a new one to replace it")
    ).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` })).toBeEnabled();
  });

  // The `"__kept__"` sentinel. The stored address never travels back to this screen, so a save
  // that carries a blank field has to mean "leave it alone" — reading it as "delete it" loses a
  // credential nobody can recover.
  await test.step("an unrelated save leaves the stored address alone", async () => {
    await page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` }).check();
    const written = saved(page);
    await page.getByRole("button", { name: "Save" }).click();
    await written;

    await page.reload();
    await expect(page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` })).toBeChecked();
    await expect(
      page.getByPlaceholder("A webhook is stored — type a new one to replace it")
    ).toBeVisible();
  });

  await test.step("the address is stored encrypted, never as it was typed", async () => {
    const handle = await db();
    const stored = await handle.collection("users").findOne({ username: MEMBER_USERNAME });
    const webhook = stored?.notifications?.chat?.webhookUrl;
    expect(webhook, "the connection was not stored at all").toBeTruthy();
    expect(webhook).not.toContain("hooks.slack.com");
  });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
