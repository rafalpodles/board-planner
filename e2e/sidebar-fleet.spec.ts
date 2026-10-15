import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";
import {
  E2E_MONGODB_URI,
  HELD_TASK_KEY,
  HELD_TASK_TITLE,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  RUN_PHASE,
  SECOND_PROJECT_ID,
  WORKER_ID,
  WORKER_NAME,
  seed,
  seedSecondProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-252: the sidebar lists the machines the reader may see — an administrator every one, anybody
 * else their own — with what each is doing, and never names a task on a board the reader cannot open.
 */

const SECRET_TITLE = "Plan nobody here may read";
const id = (hex: string) => new mongoose.Types.ObjectId(hex);
const QUIET_WORKER = id("e2e00000000000000000b252");
const IDLE_WORKER = id("e2e00000000000000000b253");
const BUSY_ELSEWHERE = id("e2e00000000000000000b254");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

function machine(_id: mongoose.Types.ObjectId, name: string, owner: mongoose.Types.ObjectId | null) {
  const now = new Date();
  return {
    _id,
    organisation: DEFAULT_ORGANISATION_ID,
    name,
    host: `${name}.local`,
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: "x",
    repos: [],
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lastSeenAt: now,
    identity: null,
    owner,
    bindingError: "",
    preflight: null,
    command: "",
    createdAt: now,
    updatedAt: now,
  };
}

function heldTask(_id: string, project: mongoose.Types.ObjectId, taskNumber: number, title: string, workerId: mongoose.Types.ObjectId, silentForMs: number) {
  const now = Date.now();
  return {
    _id: id(_id),
    organisation: DEFAULT_ORGANISATION_ID,
    project,
    taskNumber,
    title,
    description: "",
    status: "in_progress",
    priority: "medium",
    category: "user-story",
    order: 9,
    checklist: [],
    watchers: [],
    customFieldValues: {},
    createdBy: MEMBER_ID,
    execution: {
      runId: `run-${_id}`,
      workerId: String(workerId),
      attempts: 1,
      startedAt: new Date(now - silentForMs - 60_000),
      lastError: "",
      phase: RUN_PHASE,
      phaseAt: new Date(now - silentForMs),
      phaseSeq: 1,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
  const handle = await db();
  // The seeded machine becomes the member's, so the member reads it as their own
  await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: MEMBER_ID } });
  await handle.collection("workers").insertMany([
    machine(QUIET_WORKER, "quiet-mac", null),
    machine(IDLE_WORKER, "idle-mac", MEMBER_ID),
    machine(BUSY_ELSEWHERE, "busy-elsewhere", MEMBER_ID),
  ]);
  await handle.collection("tasks").insertMany([
    heldTask("e2e00000000000000000d252", PROJECT_ID, 252, "Gone quiet mid-run", QUIET_WORKER, 30 * 60_000),
    heldTask("e2e00000000000000000d253", SECOND_PROJECT_ID, 1, SECRET_TITLE, BUSY_ELSEWHERE, 0),
  ]);
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

const panel = (page: Page) => page.getByTestId("fleet-panel");
const row = (page: Page, name: string) => panel(page).getByTestId("fleet-machine").filter({ hasText: name });

test("an administrator sees every machine, what each is on, and opens the task from the sidebar", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/projects");

  await expect(row(page, WORKER_NAME)).toHaveAttribute("data-state", "running");
  await expect(row(page, WORKER_NAME)).toContainText(`Working · ${HELD_TASK_KEY} · ${RUN_PHASE}`);
  await expect(row(page, "quiet-mac")).toHaveAttribute("data-state", "quiet");
  await expect(row(page, "quiet-mac")).toContainText(`Quiet · ${PROJECT_KEY}-252`);
  await expect(row(page, "idle-mac")).toHaveAttribute("data-state", "idle");
  // An administrator can open every board, so nothing is withheld from them
  await expect(row(page, "busy-elsewhere")).toContainText("IB-1");
  await expect(panel(page).getByText("3 working")).toBeVisible();

  await row(page, WORKER_NAME).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/1$`));
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
});

test("a member sees only their own machines, and nothing of a board they cannot open", async ({ page }) => {
  await signIn(page, "member");
  const read = page.waitForResponse((r) => r.url().endsWith("/api/fleet") && r.status() === 200);
  await page.goto("/projects");
  const body = await (await read).text();

  await expect(row(page, WORKER_NAME)).toContainText(`Working · ${HELD_TASK_KEY}`);
  await expect(row(page, "idle-mac")).toContainText("Idle");
  await expect(row(page, "busy-elsewhere")).toContainText("Working · on a board you cannot open");
  await expect(row(page, "busy-elsewhere").getByRole("link")).toHaveCount(0);
  await expect(panel(page).getByTestId("fleet-machine")).toHaveCount(3);
  await expect(row(page, "quiet-mac")).toHaveCount(0);

  expect(body).not.toContain(SECRET_TITLE);
  expect(body).not.toContain("IB-");
  expect(body).not.toContain("quiet-mac");
});

test("a person with no machine is told so, with the way to connect one", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/projects");
  await expect(panel(page).getByText("No machines connected.")).toBeVisible();
  await expect(panel(page).getByRole("link", { name: "Connect one" })).toHaveAttribute("href", "/settings/machines");
});

test("a machine credential gets no fleet", async ({ request }) => {
  const { ADMIN_AUTH } = await import("./api");
  expect((await request.get("/api/fleet", { headers: ADMIN_AUTH })).status()).toBe(403);
});
