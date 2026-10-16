import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MINE_ACTIVE_TITLE,
  PLANNING_SPRINT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  WORKER_NAME,
  seed,
  seedMyTasks,
  seedSprintPlanning,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-703. An axe sweep beside the hand-written accessibility specs, which cover the screens
 * somebody thought about; this one covers every main screen and the dialogs opened from them.
 *
 * WCAG 2.0 and 2.1, levels A and AA — axe's `best-practice` rules are left out, being advice
 * rather than conformance. Nothing is baselined: every screen must report zero violations, so a
 * new one fails the job that introduced it instead of joining a list nobody reads.
 *
 * Each screen waits for something only its loaded state can show, because a spinner has nothing
 * on it to violate.
 */

const WCAG_A_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function violations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_A_AA).analyze();
  return violations.map(
    (v) =>
      `${v.id}: ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1]?.trim()}`)
        .join("\n")}`
  );
}

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(`Refusing to touch database "${dbName}": this fixture only runs against *_e2e`);
  }
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await fn(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function seedCatalog() {
  await mongoose.connect(E2E_MONGODB_URI);
  const { seedAgents } = await import("@/lib/agent-seed");
  const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
  await seedAgents(scopedToDefaultOrganisation());
  await mongoose.disconnect();
}

const NOTIFICATION_TITLE = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER} assigned to you`;

async function seedNotification() {
  await withDb((db) =>
    db.collection("notifications").insertOne({
      recipient: ADMIN_ID,
      type: "task_assigned",
      project: PROJECT_ID,
      actor: MEMBER_ID,
      title: NOTIFICATION_TITLE,
      body: SIBLING_TASK_TITLE,
      read: false,
      inApp: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
}

const BOARD = `/projects/${PROJECT_KEY}`;

const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
// The sidebar's machines panel links a held task too; a card is the page's own
const firstCard = (page: Page) => page.locator(`#main-content a[href^="${BOARD}/tasks/"]`).first();
const statusPicker = (page: Page) => page.getByRole("combobox", { name: "Status", exact: true });

async function onTheBoard(page: Page) {
  await page.goto(BOARD);
  await expect(firstCard(page)).toBeVisible();
}

interface Screen {
  name: string;
  signedOut?: boolean;
  prepare?: () => Promise<unknown>;
  open: (page: Page) => Promise<unknown>;
  ready: (page: Page) => Locator;
}

const at = (path: string) => async (page: Page) => page.goto(path);

const SCREENS: Screen[] = [
  { name: "sign-in", signedOut: true, open: at("/login"), ready: (page) => button(page, "Sign In") },
  {
    name: "forgotten password",
    signedOut: true,
    open: at("/forgot"),
    ready: (page) => heading(page, "Forgot your password?"),
  },
  { name: "projects", open: at("/projects"), ready: (page) => page.getByRole("link", { name: PROJECT_NAME }).first() },
  { name: "new project", open: at("/projects/new"), ready: (page) => heading(page, "New project") },
  { name: "board", open: at(BOARD), ready: firstCard },
  {
    name: "list",
    open: async (page) => {
      await onTheBoard(page);
      await button(page, "List").click();
    },
    ready: (page) => page.getByRole("row").filter({ hasText: SIBLING_TASK_TITLE }),
  },
  {
    name: "new task dialog",
    open: async (page) => {
      await onTheBoard(page);
      await page.getByRole("button", { name: "New task" }).click();
    },
    // AI Assist renders last, once its availability check has answered
    ready: (page) => page.getByRole("dialog", { name: "New Task" }).getByPlaceholder("Describe what you need"),
  },
  {
    name: "board filters",
    open: async (page) => {
      await onTheBoard(page);
      await page.getByRole("button", { name: /Filters/ }).first().click();
    },
    ready: (page) => page.getByRole("dialog", { name: "Filters" }),
  },
  {
    name: "keyboard shortcuts",
    open: async (page) => {
      await onTheBoard(page);
      await page.keyboard.press("?");
    },
    ready: (page) => page.getByRole("dialog", { name: "Keyboard Shortcuts" }),
  },
  {
    name: "search layer",
    open: async (page) => {
      await onTheBoard(page);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
      await page.keyboard.type("free");
    },
    ready: (page) => page.getByRole("dialog", { name: "Search" }).getByText(SIBLING_TASK_TITLE),
  },
  {
    name: "task over the board",
    open: async (page) => {
      await onTheBoard(page);
      await firstCard(page).click();
    },
    ready: statusPicker,
  },
  {
    name: "task page",
    open: at(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`),
    ready: (page) => statusPicker(page).filter({ visible: true }).first(),
  },
  {
    name: "sprints",
    prepare: seedSprintPlanning,
    open: at(`${BOARD}/sprints`),
    ready: (page) => page.getByText(PLANNING_SPRINT_NAME).first(),
  },
  {
    name: "new sprint dialog",
    prepare: seedSprintPlanning,
    open: async (page) => {
      await page.goto(`${BOARD}/sprints`);
      await button(page, "New Sprint").click();
    },
    ready: (page) => page.getByRole("dialog").filter({ has: page.getByText("Start Date") }),
  },
  {
    name: "search page",
    open: at("/search?q=free"),
    ready: (page) => page.getByRole("main").getByText(SIBLING_TASK_TITLE).first(),
  },
  { name: "dashboard", open: at(`${BOARD}/dashboard`), ready: (page) => heading(page, "Status Breakdown") },
  { name: "insights", open: at(`${BOARD}/insights`), ready: (page) => page.getByRole("main").getByRole("heading").first() },
  ...(
    [
      ["general", "General"],
      ["board", "Board"],
      ["fields", "Task fields"],
      ["notifications", "My notifications"],
      ["integrations", "Integrations"],
      ["workers", "Workers"],
      ["pm", "PM agent"],
      ["import", "Import"],
      ["audit", "Audit log"],
    ] as const
  ).map(([section, title]) => ({
    name: `project settings: ${section}`,
    open: at(`${BOARD}/settings?section=${section}`),
    ready: (page: Page) => heading(page, title),
  })),
  {
    name: "my tasks",
    prepare: seedMyTasks,
    open: at("/my-tasks"),
    ready: (page) => page.getByText(MINE_ACTIVE_TITLE),
  },
  {
    name: "notifications",
    prepare: seedNotification,
    open: at("/notifications"),
    ready: (page) => page.getByText(NOTIFICATION_TITLE),
  },
  {
    name: "agents",
    prepare: seedCatalog,
    open: at("/agents"),
    ready: (page) => page.getByRole("link", { name: /Default/ }).first(),
  },
  { name: "PM chat", open: at(`${BOARD}/pm`), ready: (page) => page.getByPlaceholder(/Message the PM/) },
  {
    name: "settings: users",
    open: at("/settings/users"),
    ready: (page) => page.getByText("@member", { exact: true }),
  },
  { name: "settings: email", open: at("/settings/email"), ready: (page) => heading(page, "Email") },
  {
    name: "settings: worker fleet",
    open: at("/settings/workers"),
    ready: (page) => page.getByRole("row").filter({ hasText: WORKER_NAME }).first(),
  },
  { name: "settings: run history", open: at("/settings/workers/runs"), ready: (page) => heading(page, "Run history") },
  { name: "settings: machines", open: at("/settings/machines"), ready: (page) => heading(page, "Machines") },
  { name: "settings: audit", open: at("/settings/audit"), ready: (page) => heading(page, "Audit log") },
  { name: "settings: agents", open: at("/settings/agents"), ready: (page) => heading(page, "PM agents") },
  { name: "settings: profile", open: at("/settings/profile"), ready: (page) => heading(page, "Profile") },
  { name: "settings: tokens", open: at("/settings/tokens"), ready: (page) => heading(page, "Create New Token") },
  {
    name: "settings: notifications",
    open: at("/settings/notifications"),
    ready: (page) => heading(page, "Notifications").first(),
  },
  { name: "settings: security", open: at("/settings/security"), ready: (page) => heading(page, "Change password") },
  { name: "settings: preferences", open: at("/settings/preferences"), ready: (page) => heading(page, "Preferences") },
  { name: "settings: AI key", open: at("/settings/ai-keys"), ready: (page) => page.getByRole("main").getByRole("heading").first() },
  { name: "settings: export", open: at("/settings/export"), ready: (page) => page.getByRole("main").getByRole("heading").first() },
  { name: "settings: licence", open: at("/settings/licence"), ready: (page) => page.getByRole("main").getByRole("heading").first() },
  { name: "settings: organisation", open: at("/settings/organisation"), ready: (page) => page.getByRole("main").getByRole("heading").first() },
  { name: "settings: single sign-on", open: at("/settings/sso"), ready: (page) => page.getByRole("main").getByRole("heading").first() },
];

test.beforeEach(seed);

for (const screen of SCREENS) {
  test(`${screen.name} has no WCAG A or AA violations`, async ({ page }) => {
    await screen.prepare?.();
    if (!screen.signedOut) await signIn(page);
    await screen.open(page);
    // Turbopack compiles a route on its first visit, and a click is not covered by navigationTimeout
    await expect(screen.ready(page)).toBeVisible({ timeout: 90_000 });
    expect(await violations(page)).toEqual([]);
  });
}

test("the sweep reports an unlabelled button, so a clean result means something", async ({ page }) => {
  await signIn(page);
  await onTheBoard(page);
  expect(await violations(page)).toEqual([]);

  await page.getByRole("main").evaluate((main) => {
    const unlabelled = document.createElement("button");
    unlabelled.innerHTML = '<svg width="16" height="16" aria-hidden="true"></svg>';
    main.prepend(unlabelled);
  });
  expect((await violations(page)).map((v) => v.split(":")[0])).toEqual(["button-name"]);
});
