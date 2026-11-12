import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_AGENT_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_ID,
  removeAllTasks,
  seed,
  seedAgents,
  seedMcpConnection,
} from "./seed";
import { signIn } from "./session";
import { SAME_ORIGIN } from "./api";

/**
 * BP-1154. One prompt for the person's coding agent, and a screen that ticks off what the agent has
 * done, read from the board rather than from anything the agent says. Here the agent's work is
 * written straight to the database, the way its MCP calls and the machine's enrolment would leave
 * it; what is under test is that the screen notices each piece and that Run hands the first task
 * to this person's machine through the ordinary task route.
 */

const REMOTE = "https://github.com/e2e/agent-setup";

test.beforeEach(async () => {
  await seed();
  await seedAgents();
  await removeAllTasks();
});

const step = (page: Page, key: string) => page.getByTestId(`setup-step-${key}`);

async function openSetup(page: Page) {
  await signIn(page, "admin");
  const first = page.waitForResponse((res) => res.url().includes("/api/onboarding/agent-setup") && res.status() === 200);
  await page.goto("/setup/agent");
  return (await first).json() as Promise<{ since: string; prompt: string }>;
}

async function db() {
  return (await mongoose.connect(E2E_MONGODB_URI)).connection.db!;
}

test("the prompt is built for this instance and the screen waits on the agent first", async ({ page }) => {
  const setup = await openSetup(page);
  const origin = new URL(page.url()).origin;

  expect(setup.prompt).toContain(`${origin}/api/mcp`);
  await expect(page.getByTestId("setup-prompt")).toContainText(`--connect ${origin}`);
  await expect(page.getByTestId("setup-prompt")).toContainText("Install the Board Planner skill");
  await expect(step(page, "agent")).toHaveAttribute("data-state", "waiting");
  await expect(step(page, "board")).toHaveAttribute("data-state", "todo");
  await expect(page.getByTestId("run-first-task")).toHaveCount(0);
});

test("a board made before the screen opened is not taken for the agent's work", async ({ page }) => {
  const handle = await db();
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { createdBy: ADMIN_ID, createdAt: new Date(Date.now() - 60 * 60_000), repositoryUrl: REMOTE } }
  );
  await mongoose.disconnect();

  await openSetup(page);
  await page.waitForTimeout(3_500);
  await expect(step(page, "board")).not.toHaveAttribute("data-state", "done");
});

test("each row ticks as the agent's work lands, and Run hands the first task to this Mac", async ({ page }) => {
  await openSetup(page);
  await expect(step(page, "agent")).toHaveAttribute("data-state", "waiting");

  await seedMcpConnection(ADMIN_ID);
  await expect(step(page, "agent")).toHaveAttribute("data-state", "done", { timeout: 10_000 });

  const handle = await db();
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { createdBy: ADMIN_ID, createdAt: new Date(), repositoryUrl: REMOTE, githubRepo: "", "worker.enabled": false } }
  );
  await expect(step(page, "board")).toHaveAttribute("data-state", "done", { timeout: 10_000 });
  await expect(step(page, "gates")).toHaveAttribute("data-state", "waiting");

  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "worker.agent": PROJECT_AGENT_ID } });
  await expect(step(page, "gates")).toHaveAttribute("data-state", "done", { timeout: 10_000 });

  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, repos: [{ remote: `${REMOTE}.git`, path: "/e2e/agent-setup" }], lastSeenAt: new Date() } }
  );
  await expect(step(page, "machine")).toContainText("runs are off", { timeout: 10_000 });
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "worker.enabled": true } });
  await expect(step(page, "machine")).toHaveAttribute("data-state", "done", { timeout: 10_000 });
  await mongoose.disconnect();

  await expect(page.getByTestId("run-first-task")).toHaveCount(0);
  const created = await page.request.post(`/api/projects/${PROJECT_ID}/tasks`, {
    headers: SAME_ORIGIN,
    data: { title: "Add a Running locally section to README.md" },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  await expect(step(page, "task")).toHaveAttribute("data-state", "done", { timeout: 10_000 });

  const run = page.getByTestId("run-first-task");
  await expect(run).toHaveText(`Run ${PROJECT_KEY}-${task.taskNumber}`);
  await run.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${task.taskNumber}$`));

  const stored = await (await db()).collection("tasks").findOne({ _id: new mongoose.Types.ObjectId(String(task._id)) });
  await mongoose.disconnect();
  expect(String(stored?.agent)).toBe(String(PROJECT_AGENT_ID));
  expect(String(stored?.assignee)).toBe(String(ADMIN_ID));
  expect(stored?.status).toBe("todo");
});
