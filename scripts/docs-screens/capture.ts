/**
 * Takes every screenshot the documentation site shows, from the demo instance demo.ts sets up, at
 * the size and scale the pages were laid out for. Names are the files under the site's
 * public/screens; pass some to take only those.
 *
 *   BASE_URL=http://localhost:3000 OUT_DIR=../board-planner-site/public/screens DEMO_PASSWORD=<same> \
 *     npx tsx scripts/docs-screens/capture.ts [name ...]
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.OUT_DIR;
const PASSWORD = process.env.DEMO_PASSWORD;

const DESKTOP = { width: 1440, height: 900 };
const TALL = { width: 1440, height: 1000 };
const WIDE = { width: 1760, height: 950 };
const PHONE = { width: 390, height: 844 };

interface Scenario {
  viewport: { width: number; height: number };
  dark?: boolean;
  signedOut?: boolean;
  // A check that has to hold at the moment of the shot rather than before it
  run: (page: Page) => Promise<void | (() => void)>;
}

let projects: Record<string, string> | null = null;

async function projectId(page: Page, key: string): Promise<string> {
  if (!projects) {
    const list: { key: string; _id: string }[] = await (await page.context().request.get(`${BASE}/api/projects`)).json();
    projects = Object.fromEntries(list.map((p) => [p.key, p._id]));
  }
  return projects[key];
}

async function taskId(page: Page, key: string, taskNumber: number): Promise<string> {
  const response = await page.context().request.get(`${BASE}/api/projects/${await projectId(page, key)}/tasks`);
  const body = await response.json();
  const tasks: { _id: string; taskNumber: number }[] = Array.isArray(body) ? body : body.tasks;
  return tasks.find((task) => task.taskNumber === taskNumber)!._id;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await settle(page);
}

async function board(page: Page): Promise<void> {
  await open(page, `/projects/${await projectId(page, "ORB")}`);
  await page.getByText("Usage-based invoice preview").first().waitFor();
}

async function taskOverBoard(page: Page): Promise<void> {
  await board(page);
  await page.getByText("Usage-based invoice preview").first().click();
  await page.getByRole("dialog").getByText("Acceptance criteria").first().waitFor();
  await settle(page);
}

async function newTask(page: Page): Promise<void> {
  await board(page);
  await page.getByRole("button", { name: /New task/ }).first().click();
  await page.getByRole("dialog", { name: "New Task" }).waitFor();
  await settle(page);
}

const projectSettings = (section: string) => async (page: Page) =>
  open(page, `/projects/${await projectId(page, "ORB")}/settings?section=${section}`);
const accountSettings = (section: string) => async (page: Page) => open(page, `/settings/${section}`);

// The demo machine goes stale five minutes after `demo.ts ready`, so the two screens that show it
// come first, and refuse to capture it stale rather than documenting a fault
async function machineIsLive(page: Page): Promise<void> {
  if (await page.getByText(/^(stale|not reporting)$/).count()) {
    throw new Error("the demo machine has gone stale: run demo.ts ready again");
  }
}

// Notifications last, in case reading the page ever starts clearing the badge the others show
const SCENARIOS: Record<string, Scenario> = {
  "settings-workers": {
    viewport: DESKTOP,
    run: async (page) => {
      await projectSettings("workers")(page);
      await machineIsLive(page);
    },
  },
  // Wide, like the list view. BP-642 pinned Enabled, Lock and Commands to the right edge, so at
  // 1440 they are on the screen — but the table is still wider than the scrollport there, and what
  // now passes under the pinned column is Last seen, whose header is caught half-drawn. Measured,
  // at 1440: a documentation screenshot reads that as a rendering fault rather than as a table
  // that scrolls. The whole table fits from about 1661.
  "admin-workers": {
    viewport: WIDE,
    run: async (page) => {
      await accountSettings("workers")(page);
      await machineIsLive(page);
    },
  },
  login: { viewport: DESKTOP, signedOut: true, run: (page) => open(page, "/login") },
  "new-project": { viewport: DESKTOP, run: (page) => open(page, "/projects/new") },
  "board-kanban": { viewport: DESKTOP, run: board },
  "board-dark": { viewport: DESKTOP, dark: true, run: board },
  "board-mobile": { viewport: PHONE, run: board },
  "board-new-task": { viewport: DESKTOP, run: newTask },
  "board-context-menu": {
    viewport: DESKTOP,
    run: async (page) => {
      await board(page);
      await page.getByText("Invoice PDF renders blank on Safari").first().click({ button: "right" });
      await page.getByRole("menu").waitFor();
      await settle(page);
    },
  },
  "board-filters-open": {
    viewport: DESKTOP,
    run: async (page) => {
      await board(page);
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByText("Assignee").first().waitFor();
      await settle(page);
    },
  },
  "board-list-view-wide": {
    viewport: WIDE,
    run: async (page) => {
      await board(page);
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.locator("tr", { hasText: "Usage-based invoice preview" }).waitFor();
      await settle(page);
    },
  },
  "command-palette": {
    viewport: DESKTOP,
    run: async (page) => {
      await board(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("invoice");
      await page.getByRole("dialog").getByText("Invoice PDF renders blank on Safari").waitFor();
      await settle(page);
    },
  },
  search: {
    viewport: DESKTOP,
    run: async (page) => {
      await open(page, "/search?q=invoice");
      await page.getByText("Invoice PDF renders blank on Safari").waitFor();
      await settle(page);
    },
  },
  "task-detail": { viewport: DESKTOP, run: taskOverBoard },
  "task-detail-dark": { viewport: DESKTOP, dark: true, run: taskOverBoard },
  "task-detail-mobile": {
    viewport: PHONE,
    run: async (page) => open(page, `/projects/${await projectId(page, "ORB")}/tasks/${await taskId(page, "ORB", 1)}`),
  },
  "task-comments": {
    viewport: DESKTOP,
    run: async (page) => {
      await taskOverBoard(page);
      await page.getByRole("tab", { name: /^Comments/ }).evaluate((tab) => tab.scrollIntoView({ block: "start" }));
      await settle(page);
    },
  },
  "task-form": { viewport: TALL, run: newTask },
  "task-form-ai-insights": {
    viewport: TALL,
    run: async (page) => {
      await newTask(page);
      await page.getByPlaceholder(/Describe what you need/).fill("Let customers export their invoice history as a CSV");
      await page.getByRole("button", { name: "Generate" }).click();
      await page.getByText(/Possible duplicate/).waitFor();
      await settle(page);
    },
  },
  "task-reference-suggestions": {
    viewport: DESKTOP,
    run: async (page) => {
      // The editor saves what is typed into it, 700 ms after the last key. Held unanswered, nothing
      // reaches the database and nothing refreshes the page; an answered save would reload the task
      // and clear the text. A save before the shot means this machine typed too slowly.
      let saved = false;
      await page.context().route("**/api/**", (route) => {
        if (route.request().method() === "GET") return route.continue();
        saved = true;
      });
      await open(page, `/projects/${await projectId(page, "ORB")}/tasks/${await taskId(page, "ORB", 11)}`);
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
      // The title is a textarea too, and it comes first
      await page.getByPlaceholder(/Markdown supported/).click();
      await page.keyboard.type("Blocked by ORB-1");
      await page.getByRole("option").first().waitFor();
      await page.waitForTimeout(250);
      const unsaved = () => {
        if (saved) throw new Error("the editor saved before the screenshot; run it again");
      };
      unsaved();
      return unsaved;
    },
  },
  dashboard: { viewport: DESKTOP, run: async (page) => open(page, `/projects/${await projectId(page, "ORB")}/dashboard`) },
  sprints: { viewport: DESKTOP, run: async (page) => open(page, `/projects/${await projectId(page, "ORB")}/sprints`) },
  "my-tasks": { viewport: DESKTOP, run: (page) => open(page, "/my-tasks") },
  "pm-chat": { viewport: DESKTOP, run: async (page) => open(page, `/projects/${await projectId(page, "ORB")}/pm`) },
  "settings-general": { viewport: DESKTOP, run: projectSettings("general") },
  "settings-board": { viewport: DESKTOP, run: projectSettings("board") },
  "settings-fields": { viewport: DESKTOP, run: projectSettings("fields") },
  "settings-integrations": { viewport: DESKTOP, run: projectSettings("integrations") },
  "settings-pm": { viewport: DESKTOP, run: projectSettings("pm") },
  "settings-audit": { viewport: DESKTOP, run: projectSettings("audit") },
  "admin-instance": { viewport: DESKTOP, run: accountSettings("profile") },
  "account-preferences": { viewport: DESKTOP, run: accountSettings("preferences") },
  "admin-tokens": { viewport: DESKTOP, run: accountSettings("tokens") },
  "admin-users": { viewport: DESKTOP, run: accountSettings("users") },
  "admin-agents": { viewport: DESKTOP, run: accountSettings("agents") },
  notifications: { viewport: DESKTOP, run: (page) => open(page, "/notifications") },
};

async function signIn(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Username").fill("alex");
  await page.getByLabel("Password").fill(PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.close();
}

async function main(): Promise<void> {
  if (!OUT || !PASSWORD) throw new Error("Set OUT_DIR and DEMO_PASSWORD");
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  const unknown = names.filter((name) => !SCENARIOS[name]);
  if (unknown.length) throw new Error(`No screenshot named ${unknown.join(", ")}`);

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const failed: string[] = [];
  try {
    for (const name of names) {
      const scenario = SCENARIOS[name];
      const phone = scenario.viewport === PHONE;
      const context = await browser.newContext({
        viewport: scenario.viewport,
        deviceScaleFactor: 2,
        colorScheme: scenario.dark ? "dark" : "light",
        // A running build's badge pulses, and a frame taken mid-pulse shows it faded
        reducedMotion: "reduce",
        locale: "en-GB",
        timezoneId: "Europe/Warsaw",
        isMobile: phone,
        hasTouch: phone,
      });
      const page = await context.newPage();
      try {
        if (!scenario.signedOut) await signIn(context);
        const stillTrue = await scenario.run(page);
        await page.screenshot({ path: join(OUT, `${name}.png`) });
        stillTrue?.();
        console.log(`captured ${name}`);
      } catch (error) {
        failed.push(name);
        const evidence = join(tmpdir(), `docs-screens-failed-${name}.png`);
        await page.screenshot({ path: evidence }).catch(() => undefined);
        console.error(`FAILED ${name}: ${(error as Error).message.split("\n")[0]} (screen at ${evidence})`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failed.length) throw new Error(`Not captured: ${failed.join(" ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
