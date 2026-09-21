import { test, expect, type Page } from "@playwright/test";
import crypto from "crypto";
import mongoose from "mongoose";
import { WEBHOOK_RECEIVER_URL, WEBHOOK_SECRET } from "../playwright.config";
import {
  BYSTANDER_PASSWORD,
  BYSTANDER_USERNAME,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  seed,
  seedBoardFeedBystander,
} from "./seed";
import { signIn, signInThroughForm } from "./session";
import { assignANewTask, db, dispatchHasRun, saved } from "./notification-grid";

/**
 * BP-408, BP-696. The first deliveries this suite ever receives. `WEBHOOK_DESTINATION` lets the
 * three senders reach `e2e/webhook-receiver.mjs` on 127.0.0.1 only under `E2E=1` outside a
 * production build; everywhere else the address is refused at save and again at delivery.
 */

interface Delivery {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;
const ASSIGNED_ROW = "A task is assigned to you";
const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });
const lastToast = (page: Page) => page.getByTestId("toast").last();

async function deliveries(path: string): Promise<Delivery[]> {
  const all: Delivery[] = await (await fetch(`${WEBHOOK_RECEIVER_URL}/deliveries`)).json();
  return all.filter((d) => d.url === path);
}

async function deliveryCarrying(path: string, text: string): Promise<Delivery> {
  let found: Delivery | undefined;
  await expect(async () => {
    const arrived = await deliveries(path);
    found = arrived.find((d) => d.body.includes(text));
    expect(found, `nothing carrying "${text}" reached ${path}; it holds ${JSON.stringify(arrived.map((d) => d.body))}`).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  return found!;
}

async function expectNothingCarrying(path: string, text: string) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect((await deliveries(path)).filter((d) => d.body.includes(text))).toHaveLength(0);
}

async function taskKeyOf(title: string): Promise<string> {
  const task = await (await db()).collection("tasks").findOne({ project: PROJECT_ID, title });
  if (!task) throw new Error(`no task called ${title}`);
  return `${PROJECT_KEY}-${task.taskNumber}`;
}

async function openConnection(page: Page, name: RegExp) {
  await page.goto(SETTINGS);
  const picker = page.getByRole("button", { name: "Add a connection" });
  const row = page.getByRole("button", { name });
  await expect(picker.or(row).first()).toBeVisible();
  await expect(async () => {
    if (!(await row.first().isVisible())) {
      if (await picker.isVisible()) await picker.click();
      await page.getByRole("button", { name }).first().click();
    }
    await row.first().click();
  }).toPass({ timeout: 20_000 });
}

async function connectPersonalChat(page: Page, kind: "slack" | "discord", url: string) {
  await page.goto("/settings/notifications");
  await page.getByRole("button", { name: kind }).click();
  const address = page.getByPlaceholder(
    kind === "slack" ? "https://hooks.slack.com/services/..." : "https://discord.com/api/webhooks/..."
  );
  await address.fill(url);
  await expect(address).toHaveValue(url);
  const written = saved(page);
  await page.getByRole("button", { name: "Save" }).click();
  await written;

  await page.reload();
  const cell = page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` });
  await expect(cell).toBeEnabled();
}

async function setChatCell(page: Page, on: boolean) {
  await page.goto("/settings/notifications");
  const cell = page.getByRole("checkbox", { name: `${ASSIGNED_ROW} — Chat` });
  await expect(cell).toBeEnabled();
  if (on) await cell.check();
  else await cell.uncheck();
  const written = saved(page);
  await page.getByRole("button", { name: "Save" }).click();
  await written;
}

test.beforeEach(async () => {
  await seed();
  await fetch(`${WEBHOOK_RECEIVER_URL}/reset`, { method: "POST" });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a project webhook is received, signed with the instance's secret, and reported delivered", async ({
  page,
}) => {
  const path = "/project-webhook";
  await signIn(page);

  await test.step("the owner adds the receiver as a webhook", async () => {
    await openConnection(page, /^Webhooks/);
    await page.getByLabel("New webhook URL").fill(`${WEBHOOK_RECEIVER_URL}${path}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const created = page.waitForResponse(
      (r) => r.url().includes("/webhooks") && r.request().method() === "POST"
    );
    await saveButton(page).click();
    expect((await created).status()).toBe(201);
  });

  const title = "Delivered to the project webhook";
  await assignANewTask(page, title, MEMBER_USERNAME);

  const delivery = await deliveryCarrying(path, title);

  await test.step("the body is the event, as the receiver got it", async () => {
    expect(delivery.method).toBe("POST");
    const body = JSON.parse(delivery.body);
    expect(body.event).toBe("task_created");
    expect(body.project.key).toBe(PROJECT_KEY);
    expect(body.task.title).toBe(title);
    expect(body.task.taskKey).toMatch(new RegExp(`^${PROJECT_KEY}-\\d+$`));
  });

  await test.step("the signature verifies against the bytes that arrived", async () => {
    const timestamp = delivery.headers["x-boardplanner-timestamp"];
    const signature = delivery.headers["x-boardplanner-signature"];
    expect(timestamp).toMatch(/^\d+$/);
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${delivery.body}`)
      .digest("hex");
    expect(signature).toBe(`t=${timestamp},v1=${expected}`);

    const forged = crypto.createHmac("sha256", "not-the-secret").update(`${timestamp}.${delivery.body}`).digest("hex");
    expect(signature).not.toContain(forged);
  });

  await test.step("the settings row says the last delivery went through", async () => {
    await expect(async () => {
      await openConnection(page, /^Webhooks/);
      await expect(page.getByText(/^Last delivered /)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });
});

test("an address this instance may not post to is refused when it is saved, not at delivery", async ({
  page,
}) => {
  await signIn(page);
  await openConnection(page, /^Webhooks/);

  await page.getByLabel("New webhook URL").fill("http://10.0.0.5/hook");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const refused = page.waitForResponse(
    (r) => r.url().includes("/webhooks") && r.request().method() === "POST"
  );
  await saveButton(page).click();
  expect((await refused).status()).toBe(400);
  await expect(lastToast(page)).toContainText("must be https and reachable on the public internet");

  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.webhooks ?? []).toHaveLength(0);

  await test.step("the team channel form refuses it the same way", async () => {
    await openConnection(page, /^Team channels/);
    await page.getByLabel("New channel name").fill("Private");
    await page.getByLabel("New channel webhook URL").fill("http://10.0.0.5/hook");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const channel = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "POST"
    );
    await saveButton(page).click();
    expect((await channel).status()).toBe(400);
    await expect(lastToast(page)).toContainText("must be https and reachable on the public internet");
  });
});

test("a team channel announces the board to a room, with no recipient in it", async ({ page }) => {
  const path = "/team-channel";
  await signIn(page);

  await openConnection(page, /^Team channels/);
  await page.getByLabel("New channel name").fill("Announcements");
  await page.getByLabel("New channel webhook URL").fill(`${WEBHOOK_RECEIVER_URL}${path}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const created = page.waitForResponse(
    (r) => r.url().includes("/notifications") && r.request().method() === "POST"
  );
  await saveButton(page).click();
  expect((await created).status()).toBe(201);

  const title = "Announced to the team channel";
  await assignANewTask(page, title, MEMBER_USERNAME);

  const body = JSON.parse((await deliveryCarrying(path, title)).body);
  const text = JSON.stringify(body.blocks);
  expect(text).toContain("New task created in");
  expect(text).not.toContain("Assigned to you");
  expect(body.text).toBeUndefined();
});

test("a ticked chat cell posts to the reader's own Slack or Discord, and unticking stops it", async ({
  browser,
}) => {
  await seedBoardFeedBystander();
  const memberPath = "/chat/member-slack";
  const bystanderPath = "/chat/bystander-discord";

  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const bystanderContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const bystander = await bystanderContext.newPage();
  await signIn(admin);
  await signIn(member, "member");
  await signInThroughForm(bystander, BYSTANDER_USERNAME, BYSTANDER_PASSWORD);

  await test.step("each reader connects their own service and ticks chat for assignments", async () => {
    await connectPersonalChat(member, "slack", `${WEBHOOK_RECEIVER_URL}${memberPath}`);
    await setChatCell(member, true);
    await connectPersonalChat(bystander, "discord", `${WEBHOOK_RECEIVER_URL}${bystanderPath}`);
    await setChatCell(bystander, true);
  });

  await assignANewTask(admin, "Slack message for the member", MEMBER_USERNAME);
  await assignANewTask(admin, "Discord message for the bystander", BYSTANDER_USERNAME);
  const forMember = await taskKeyOf("Slack message for the member");
  const forBystander = await taskKeyOf("Discord message for the bystander");

  await test.step("Slack gets mrkdwn text addressed to the reader, linking the task", async () => {
    const body = JSON.parse((await deliveryCarrying(memberPath, `${forMember} `)).body);
    expect(Object.keys(body)).toEqual(["text"]);
    const number = forMember.split("-")[1];
    expect(body.text).toMatch(
      new RegExp(`^\\*Assigned to you\\*\\n<http[^|>]+/projects/${PROJECT_KEY}/tasks/${number}\\|${forMember} assigned to you>$`)
    );
  });

  await test.step("Discord gets content with the link on its own line, and pings nobody", async () => {
    const body = JSON.parse((await deliveryCarrying(bystanderPath, `${forBystander} `)).body);
    const number = forBystander.split("-")[1];
    expect(body.content).toMatch(
      new RegExp(`^\\*\\*Assigned to you\\*\\*\\n${forBystander} assigned to you\\nhttp\\S+/projects/${PROJECT_KEY}/tasks/${number}$`)
    );
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.text).toBeUndefined();
  });

  await test.step("each message went only to its own reader", async () => {
    expect(await deliveries(memberPath)).toHaveLength(1);
    expect(await deliveries(bystanderPath)).toHaveLength(1);
  });

  await test.step("the member unticks chat; the bystander keeps it as the control", async () => {
    await setChatCell(member, false);
  });

  await assignANewTask(admin, "After the member unticked", MEMBER_USERNAME);
  await assignANewTask(admin, "Still ticked for the bystander", BYSTANDER_USERNAME);
  const afterMember = await taskKeyOf("After the member unticked");
  const afterBystander = await taskKeyOf("Still ticked for the bystander");

  await deliveryCarrying(bystanderPath, `${afterBystander} `);
  await dispatchHasRun(member, "After the member unticked");
  await expectNothingCarrying(memberPath, `${afterMember} `);
  expect(await deliveries(memberPath)).toHaveLength(1);

  await adminContext.close();
  await memberContext.close();
  await bystanderContext.close();
});
