import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_NAME,
  seed,
  seedMyTasks,
  seedSprintPlanning,
} from "./seed";
import { signIn } from "./session";
import {
  cutOffAtTheRight,
  expectNoHorizontalPageScroll,
  expectReachable,
  headingClippedAtTheTop,
} from "./reachable";

/**
 * BP-710. The board, task detail and search were all driven at phone width; these screens never
 * were, and the fleet table's hidden controls (BP-642) and sideways-only preflight failures
 * (BP-689) are the kind of defect that lands exactly there.
 *
 * Reachable is measured, not `toBeVisible()`: an element parked past the right edge satisfies that.
 */

test.use({ viewport: { width: 390, height: 844 } });

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
  const { scopedToDefaultTenant } = await import("@/lib/db-scope");
  await seedAgents(scopedToDefaultTenant());
  await mongoose.disconnect();
}

async function seedUnreadNotification() {
  await withDb((db) =>
    db.collection("notifications").insertOne({
      recipient: ADMIN_ID,
      type: "task_assigned",
      project: PROJECT_ID,
      actor: MEMBER_ID,
      title: `${PROJECT_KEY}-3 assigned to you`,
      body: "Free to move",
      read: false,
      inApp: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
}

const LONG_AUDIT_TARGET = "a-worker-with-a-very-long-hostname.build-farm.internal.example.com";

async function seedAuditRow() {
  await withDb((db) =>
    db.collection("instanceauditlogs").insertOne({
      user: ADMIN_ID,
      actorUsername: "admin",
      action: "worker_command_sent",
      target: LONG_AUDIT_TARGET,
      detail: "stop, sent while the machine was midway through a run of the agent step",
      createdAt: new Date(),
    })
  );
}

async function defaultAgentPath(): Promise<string> {
  const agent = await withDb((db) => db.collection("agents").findOne({ name: "Default" }));
  expect(agent, "the shipped Default agent was not seeded").not.toBeNull();
  return `/agents/${agent!._id}`;
}

interface Screen {
  name: string;
  path: string | (() => Promise<string>);
  prepare?: () => Promise<unknown>;
  landmark: (page: Page) => Locator;
  actions: (page: Page) => Record<string, Locator>;
  alsoHolds?: (page: Page) => Promise<void>;
  widths?: number[];
}

const PM_PLACEHOLDER_NARROW = "Message the PM… (paste to attach)";
const PM_PLACEHOLDER_WIDE =
  "Message the PM… (Enter sends, Shift+Enter for a new line, paste to attach)";

// A textarea's scrollHeight ignores its placeholder, so the placeholder is typed into a clone
// that shares the box's parent, classes and inline style, and the clone's overflow is read
async function placeholderOverflow(textarea: Locator): Promise<number> {
  return textarea.evaluate((el: HTMLTextAreaElement) => {
    const mirror = el.cloneNode() as HTMLTextAreaElement;
    mirror.value = el.placeholder;
    el.parentElement!.appendChild(mirror);
    try {
      if (mirror.clientWidth !== el.clientWidth || mirror.clientHeight !== el.clientHeight) {
        throw new Error(
          `mirror is ${mirror.clientWidth}x${mirror.clientHeight}, box is ${el.clientWidth}x${el.clientHeight}`
        );
      }
      return mirror.scrollHeight - mirror.clientHeight;
    } finally {
      mirror.remove();
    }
  });
}

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

const SCREENS: Screen[] = [
  {
    name: "sprints",
    path: `/projects/${PROJECT_KEY}/sprints`,
    prepare: seedSprintPlanning,
    landmark: (page) => heading(page, "Sprints"),
    actions: (page) => ({ "New Sprint": button(page, "New Sprint") }),
  },
  {
    name: "PM chat",
    path: `/projects/${PROJECT_KEY}/pm`,
    landmark: (page) => page.getByPlaceholder(/Message the PM/),
    actions: (page) => ({
      composer: page.getByPlaceholder(/Message the PM/),
      Send: button(page, "Send"),
    }),
    alsoHolds: async (page) => {
      const composer = page.getByPlaceholder(/Message the PM/);
      await expect(composer).toHaveAttribute("placeholder", PM_PLACEHOLDER_NARROW);
      expect(await placeholderOverflow(composer), "px of the placeholder cut off below the box").toBe(0);
    },
  },
  {
    name: "agents catalog",
    path: "/agents",
    prepare: seedCatalog,
    landmark: (page) => page.getByRole("link", { name: /Default/ }),
    actions: (page) => ({ "New agent": button(page, "New agent") }),
  },
  {
    name: "agent detail",
    path: defaultAgentPath,
    prepare: seedCatalog,
    landmark: (page) => page.getByRole("heading", { name: "Default", level: 1 }),
    actions: (page) => ({ Save: button(page, "Save") }),
  },
  {
    name: "notifications",
    path: "/notifications",
    prepare: seedUnreadNotification,
    landmark: (page) => page.getByText(`${PROJECT_KEY}-3 assigned to you`),
    actions: (page) => ({ "Mark all as read": button(page, "Mark all as read") }),
  },
  {
    name: "my tasks",
    path: "/my-tasks",
    prepare: seedMyTasks,
    landmark: (page) => heading(page, "My Tasks"),
    actions: (page) => ({ "first task row": page.locator('main a[href*="/tasks/"]').first() }),
  },
  {
    name: "instance users",
    path: "/settings/users",
    landmark: (page) => heading(page, "Users"),
    actions: (page) => ({ "New User": button(page, "New User") }),
    widths: [390, 768],
    alsoHolds: async (page) => {
      for (const name of ["E2E Admin", "E2E Member", "E2E Owner"]) {
        const shown = page.locator("main").getByText(name, { exact: true });
        const widths = await shown.evaluate((el) => ({ full: el.scrollWidth, visible: el.clientWidth }));
        expect(widths.full, `${name} is truncated`).toBeLessThanOrEqual(widths.visible);
      }
    },
  },
  {
    name: "instance audit",
    path: "/settings/audit",
    prepare: seedAuditRow,
    landmark: (page) => page.getByText(LONG_AUDIT_TARGET),
    actions: (page) => ({ "the logged row's target": page.getByText(LONG_AUDIT_TARGET) }),
  },
  {
    name: "instance email",
    path: "/settings/email",
    landmark: (page) => heading(page, "Email"),
    actions: (page) => ({ "Send a test message": button(page, "Send a test message") }),
    // A 192px label column left the sender's address 120px, broken every few letters
    alsoHolds: async (page) => {
      const row = page.locator("dl > div").filter({ has: page.getByText("From", { exact: true }) });
      const label = await row.locator("dt").boundingBox();
      const value = await row.locator("dd").boundingBox();
      expect(value!.width, "the address gets less room than the word From").toBeGreaterThan(
        label!.width
      );
    },
  },
  {
    name: "worker fleet",
    path: "/settings/workers",
    landmark: (page) => page.getByRole("row").filter({ hasText: WORKER_NAME }).first(),
    actions: (page) => ({ "Enrol a worker": button(page, "Enrol a worker") }),
  },
];

test.beforeEach(seed);

for (const screen of SCREENS) {
  for (const width of screen.widths ?? [390]) {
    test(`${screen.name} fits a ${width}px screen and its primary action is reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await screen.prepare?.();
      const path = typeof screen.path === "string" ? screen.path : await screen.path();
      await signIn(page);
      await page.goto(path);
      await expect(screen.landmark(page)).toBeVisible();

      await expectNoHorizontalPageScroll(page);
      expect(await cutOffAtTheRight(page), "cut off past the right edge").toEqual([]);
      expect(await headingClippedAtTheTop(page), "px of the page heading hidden above the scrollport").toBe(0);
      for (const [name, action] of Object.entries(screen.actions(page))) {
        await expect(action).toBeAttached();
        expect(await expectReachable(page, action, name), `${name} needed a sideways scroll`).toBe(
          "in-place"
        );
      }
      await screen.alsoHolds?.(page);
    });
  }
}

test("the PM composer keeps its keyboard hints on a desktop, where they fit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  const composer = page.getByPlaceholder(/Message the PM/);
  await expect(composer).toHaveAttribute("placeholder", PM_PLACEHOLDER_WIDE);
  expect(await placeholderOverflow(composer), "px of the placeholder cut off below the box").toBe(0);
});

const maskOfFleetScroller = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("table")!.parentElement!).maskImage);

test("the fleet table's controls are reached by scrolling the table, which says it scrolls", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/workers");
  const row = page.getByRole("row").filter({ hasText: WORKER_NAME }).first();
  await expect(row).toBeVisible();

  await expect.poll(() => maskOfFleetScroller(page), { message: "nothing says the table continues" }).toContain(
    "gradient"
  );

  // On is the kill switch, Pause/Resume/Stop are the commands
  for (const name of ["On", "Pause", "Resume", "Stop"]) {
    await page.evaluate(() => {
      document.querySelector("table")!.parentElement!.scrollLeft = 0;
    });
    const how = await expectReachable(page, row.getByRole("button", { name, exact: true }), name);
    expect(how, `${name} fits without scrolling, so this no longer tests the scroller`).toBe(
      "scrolled"
    );
  }
  await expectNoHorizontalPageScroll(page);
});
