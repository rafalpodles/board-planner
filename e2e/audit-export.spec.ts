import { test, expect, type Download, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { ADMIN_ID, E2E_MONGODB_URI, OWNER_ID, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";
import { signIn } from "./session";

/**
 * BP-860: both audit logs filter by date, action and actor, page by cursor, and download as CSV or
 * NDJSON — for an administrator and a project owner, never for a machine credential or a member.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=audit`;
const FORMULA = '=HYPERLINK("http://evil.example","click")';

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const at = (daysAgo: number, minute = 0) => new Date(Date.UTC(2026, 9, 14 - daysAgo, 12, minute));

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("instanceauditlogs").deleteMany({});
  await handle.collection("projectauditlogs").deleteMany({});
  // 205 rows: one more than the instance log's page, so the last of them only arrives on "Load more"
  await handle.collection("instanceauditlogs").insertMany([
    ...Array.from({ length: 203 }, (_, i) => ({
      organisation: DEFAULT_ORGANISATION_ID,
      user: ADMIN_ID,
      actorUsername: "admin",
      action: "worker_renamed",
      target: `machine-${i}`,
      detail: `rename ${i}`,
      createdAt: at(1, i % 60),
    })),
    {
      organisation: DEFAULT_ORGANISATION_ID,
      user: null,
      actorUsername: "",
      action: "worker_disabled",
      target: "old-mac",
      detail: FORMULA,
      createdAt: at(30),
    },
    {
      organisation: DEFAULT_ORGANISATION_ID,
      user: null,
      actorUsername: "",
      action: "enrolment_token_spent",
      target: "new-mac",
      detail: "",
      createdAt: at(0),
    },
  ]);
  await handle.collection("projectauditlogs").insertMany([
    { organisation: DEFAULT_ORGANISATION_ID, project: PROJECT_ID, user: OWNER_ID, action: "label_added", detail: FORMULA, createdAt: at(2) },
    { organisation: DEFAULT_ORGANISATION_ID, project: PROJECT_ID, user: ADMIN_ID, action: "settings_updated", detail: "", lines: ["Name: A → B"], createdAt: at(1) },
  ]);
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

async function downloaded(page: Page, link: string): Promise<{ name: string; text: string }> {
  const download: Promise<Download> = page.waitForEvent("download");
  await page.getByRole("link", { name: link, exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, "utf8") };
}

test("an administrator filters, pages and downloads the organisation's audit log", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/settings/audit");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(200);
  await expect(rows.first()).toContainText("new-mac");

  const more = page.waitForResponse((r) => /\/api\/admin\/audit\?before=[a-f\d]{24}$/.test(r.url()));
  await page.getByRole("button", { name: "Load more" }).click();
  expect((await more).status()).toBe(200);
  await expect(rows).toHaveCount(205);
  await expect(rows.last()).toContainText("old-mac");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await page.getByLabel("Action", { exact: true }).selectOption("worker_disabled");
  const filtered = page.waitForResponse((r) => r.url().includes("/api/admin/audit?action=worker_disabled"));
  await page.getByRole("button", { name: "Apply" }).click();
  await filtered;
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("old-mac");

  const csv = await downloaded(page, "CSV");
  expect(csv.name).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.text.split("\r\n")).toEqual([
    "createdAt,actor,action,target,detail",
    `${at(30).toISOString()},system,worker_disabled,old-mac,"'=HYPERLINK(""http://evil.example"",""click"")"`,
    "",
  ]);

  await page.getByLabel("Action", { exact: true }).selectOption("");
  await page.getByLabel("From", { exact: true }).fill("2026-10-13");
  await page.getByLabel("To", { exact: true }).fill("2026-10-13");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(rows).toHaveCount(200);
  const ndjson = await downloaded(page, "NDJSON");
  const lines = ndjson.text.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(203);
  expect(new Set(lines.map((l) => l.action))).toEqual(new Set(["worker_renamed"]));
});

test("a project owner filters and downloads the project's log", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(SETTINGS);
  const card = page.locator("section").filter({ hasText: "Recent changes" });
  await expect(card.locator("tbody tr")).toHaveCount(2);

  await card.getByLabel("Actor").fill("owner");
  await card.getByRole("button", { name: "Apply" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(1);
  await expect(card.locator("tbody tr")).toContainText("label added");

  const csv = await downloaded(page, "CSV");
  expect(csv.name).toMatch(new RegExp(`^${PROJECT_KEY.toLowerCase()}-audit-log-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  expect(csv.text).toBe(
    `createdAt,actor,action,detail\r\n${at(2).toISOString()},owner,label_added,"'=HYPERLINK(""http://evil.example"",""click"")"\r\n`
  );

  await card.getByRole("button", { name: "Clear" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(2);
  const ndjson = await downloaded(page, "NDJSON");
  expect(ndjson.text.trim().split("\n").map((l) => JSON.parse(l).detail)).toEqual(["Name: A → B", FORMULA]);
});

test("a member who is not an owner, and every machine credential, are refused the export", async ({ page, request }) => {
  const project = `/api/projects/${PROJECT_ID}/audit/export`;
  expect((await request.get(project, { headers: MEMBER_AUTH })).status()).toBe(403);
  expect((await request.get(project, { headers: ADMIN_AUTH })).status()).toBe(403);
  expect((await request.get("/api/admin/audit/export", { headers: ADMIN_AUTH })).status()).toBe(403);

  await signIn(page, "member");
  expect((await page.request.get(project)).status()).toBe(403);
  expect((await page.request.get("/api/admin/audit/export")).status()).toBe(403);

  // The control: the same requests from the people the logs belong to
  await signIn(page, "owner");
  expect((await page.request.get(project)).status()).toBe(200);
  await signIn(page, "admin");
  expect((await page.request.get("/api/admin/audit/export")).status()).toBe(200);
});
