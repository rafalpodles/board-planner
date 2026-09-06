import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

const CHANNEL_A = "alpha-room";
const CHANNEL_B = "beta-room";
const WEBHOOK_A = "https://example.com/hooks/alpha";
const WEBHOOK_B = "https://example.com/hooks/beta";
const WEBHOOK_A_MASKED = "https://example.com/••••lpha";
const WEBHOOK_B_MASKED = "https://example.com/••••beta";

async function withTwoOfEverything() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  const oid = () => new mongoose.Types.ObjectId();
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        "pm.mcpServers": [
          { name: "acme", url: "https://acme.example/mcp", authType: "none" },
          { name: "zenith", url: "https://zenith.example/mcp", authType: "none" },
        ],
        notificationChannels: [
          {
            _id: oid(),
            type: "slack",
            name: CHANNEL_A,
            webhookUrl: "https://hooks.slack.com/services/alpha",
            events: ["task_created", "status_changed", "comment_added"],
            enabled: true,
          },
          {
            _id: oid(),
            type: "discord",
            name: CHANNEL_B,
            webhookUrl: "https://discord.com/api/webhooks/beta",
            events: ["task_created"],
            enabled: false,
          },
        ],
        webhooks: [
          { _id: oid(), url: WEBHOOK_A, events: ["task_created"], enabled: true },
          { _id: oid(), url: WEBHOOK_B, events: ["status_changed"], enabled: false },
        ],
        "worker.policyOverrides": ["baseBranch", "taskTimeoutMs"],
      },
    }
  );
}

async function withCollidingRows() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  const oid = () => new mongoose.Types.ObjectId();
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        "pm.mcpServers": [
          { name: "acme", url: "https://acme.example/mcp", authType: "none" },
          { name: "acme", url: "https://acme-two.example/mcp", authType: "none" },
        ],
        notificationChannels: [
          {
            _id: oid(),
            type: "slack",
            name: "alerts",
            webhookUrl: "https://hooks.slack.com/services/alerts",
            events: ["task_created"],
            enabled: true,
          },
          {
            _id: oid(),
            type: "discord",
            name: "alerts",
            webhookUrl: "https://discord.com/api/webhooks/alerts",
            events: ["task_created"],
            enabled: false,
          },
        ],
        webhooks: [
          {
            _id: oid(),
            url: "https://example.com/hooks/board",
            events: ["task_created"],
            enabled: true,
          },
          {
            _id: oid(),
            url: "https://example.com/hooks/second-board",
            events: ["status_changed"],
            enabled: false,
          },
        ],
      },
    }
  );
}

const NAMED_ROLES = [
  "button",
  "textbox",
  "combobox",
  "checkbox",
  "switch",
  "link",
  "searchbox",
  "spinbutton",
];

async function namelessControls(scope: Locator) {
  const snapshot = await scope.ariaSnapshot();
  const lines = snapshot.split("\n");
  const examined: string[] = [];
  const nameless: string[] = [];
  for (const line of lines) {
    const match = /^\s*-\s+([a-z]+)(\s+"(?:[^"\\]|\\.)*")?/.exec(line);
    if (!match) continue;
    const [, role, name] = match;
    if (!NAMED_ROLES.includes(role)) continue;
    examined.push(line.trim());
    if (!name || !name.slice(2, -1).trim()) nameless.push(line.trim());
  }
  return { examined, nameless };
}

async function pmSection(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
  await expect(page.getByLabel("Authentication for acme")).toBeVisible();
}

function card(page: Page, heading: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

async function openConnection(page: Page, name: RegExp) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  const card = page.getByRole("button", { name });
  await expect(card).toHaveAttribute("aria-expanded", "false");
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "true");
}

test.describe("a settings row says which row it is", () => {
  test("every control in an MCP server row carries that server's name", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await pmSection(page);

    await expect(page.getByLabel("Name for acme")).toHaveValue("acme");
    await expect(page.getByLabel("Name for zenith")).toHaveValue("zenith");

    await expect(page.getByLabel("URL for acme")).toHaveValue("https://acme.example/mcp");
    await expect(page.getByLabel("URL for zenith")).toHaveValue("https://zenith.example/mcp");
    await expect(page.getByLabel("Tool allowlist for acme")).toHaveCount(1);

    for (const name of ["Remove acme", "Remove zenith", "Test connection for acme"]) {
      await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(1);
    }
  });

  test("the name of a server row's controls follows the name being typed into it", async ({
    page,
  }) => {
    await withTwoOfEverything();
    await signIn(page);
    await pmSection(page);

    await page.getByLabel("Name for acme").fill("acme-two");
    await expect(page.getByRole("button", { name: "Remove acme-two" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove acme", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove zenith" })).toHaveCount(1);
  });

  test("a channel's delete and event chips name the channel", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await openConnection(page, /^Team channels/);

    await expect(page.getByRole("button", { name: `Delete ${CHANNEL_A}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Delete ${CHANNEL_B}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    await expect(page.getByRole("button", { name: `Delete ${CHANNEL_A}` })).toHaveAccessibleName(
      `Delete ${CHANNEL_A}`
    );
    await expect(
      page.getByRole("button", { name: `Enabled for ${CHANNEL_B}` })
    ).toHaveAccessibleName(`Enabled for ${CHANNEL_B}`);

    await expect(
      page.getByRole("button", { name: `task created for ${CHANNEL_A}` })
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `task created for ${CHANNEL_B}` })
    ).toHaveCount(1);

    await expect(
      page.getByRole("button", { name: `comment added for ${CHANNEL_A}` })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: `comment added for ${CHANNEL_B}` })
    ).toHaveAttribute("aria-pressed", "false");
  });

  test("the enable toggle keeps its name when the state it used to be named after changes", async ({
    page,
  }) => {
    await withTwoOfEverything();
    await signIn(page);
    await openConnection(page, /^Team channels/);

    const toggle = page.getByRole("button", { name: `Enabled for ${CHANNEL_A}` });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveText("Active");

    await toggle.click();

    await expect(toggle).toHaveText("Disabled");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `Enabled for ${CHANNEL_B}` })
    ).toHaveAttribute("aria-pressed", "false");
  });

  test("a webhook row is told apart by the only thing it has — its masked URL", async ({
    page,
  }) => {
    await withTwoOfEverything();
    await signIn(page);
    await openConnection(page, /^Webhooks/);

    await expect(page.getByRole("button", { name: `Delete ${WEBHOOK_A_MASKED}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Delete ${WEBHOOK_B_MASKED}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    await expect(
      page.getByRole("button", { name: `Enabled for ${WEBHOOK_A_MASKED}` })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: `Enabled for ${WEBHOOK_B_MASKED}` })
    ).toHaveAttribute("aria-pressed", "false");

    await expect(
      page.getByRole("button", { name: `Replace URL for ${WEBHOOK_A_MASKED}` })
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Replace", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: `Replace URL for ${WEBHOOK_A_MASKED}` }).click();
    await page.getByRole("button", { name: `Replace URL for ${WEBHOOK_B_MASKED}` }).click();
    await expect(page.getByRole("button", { name: `Save URL for ${WEBHOOK_A_MASKED}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Save URL for ${WEBHOOK_B_MASKED}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Cancel URL for ${WEBHOOK_A_MASKED}` })
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  });

  test("two channels sharing a name are still told apart", async ({ page }) => {
    await withCollidingRows();
    await signIn(page);
    await openConnection(page, /^Team channels/);

    await expect(page.getByText("alerts", { exact: true })).toHaveCount(2);

    const first = page.getByRole("button", { name: "Delete alerts (1)" });
    const second = page.getByRole("button", { name: "Delete alerts (2)" });
    await expect(first).toHaveCount(1);
    await expect(second).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Enabled for alerts (1)" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByRole("button", { name: "Enabled for alerts (2)" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("two webhooks whose masks collide are still told apart", async ({ page }) => {
    await withCollidingRows();
    await signIn(page);
    await openConnection(page, /^Webhooks/);

    const masked = "https://example.com/••••oard";
    await expect(page.getByText(masked, { exact: true })).toHaveCount(2);

    await expect(page.getByRole("button", { name: `Delete ${masked} (1)` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Delete ${masked} (2)` })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `Replace URL for ${masked} (1)` })
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `status changed for ${masked} (2)` })
    ).toHaveCount(1);
  });

  test("two MCP servers sharing a name are still told apart", async ({ page }) => {
    await withCollidingRows();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);

    await expect(page.getByLabel("Name for acme (1)")).toHaveValue("acme");
    await expect(page.getByLabel("Name for acme (2)")).toHaveValue("acme");
    await expect(page.getByRole("button", { name: "Remove acme (1)" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove acme (2)" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove acme", exact: true })).toHaveCount(0);
  });

  test("each policy field names itself, and so does the button that resets it", async ({
    page,
  }) => {
    await withTwoOfEverything();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();

    await expect(page.getByLabel("Base branch", { exact: true })).toHaveValue("main");
    await expect(page.getByLabel("Timeout for one step (ms)", { exact: true })).toHaveValue(
      "1800000"
    );

    await expect(page.getByRole("button", { name: "set · reset Base branch" })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "set · reset Timeout for one step (ms)" })
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "set · reset", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "set · reset Base branch" }).click();
    await expect(page.getByRole("button", { name: "set · reset Base branch" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "set · reset Timeout for one step (ms)" })
    ).toHaveCount(1);
  });

  test("the task search box keeps its name once somebody types into it", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await page.getByRole("button", { name: "+ Add dependency" }).click();

    const search = page.getByLabel("Search tasks to link");
    await expect(search).toHaveCount(1);
    await expect(search).toHaveAccessibleName("Search tasks to link");

    await search.fill("Free");
    await expect(search).toHaveValue("Free");
    await expect(search).toHaveAccessibleName("Search tasks to link");
  });
});

test.describe("a Connections card is announced by its own name", () => {
  test("before anything is connected, in the picker", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);

    const card = page.getByRole("button", { name: /^Team channels/ });
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveAccessibleName(/^Slack/);
  });

  test("and once it is, in the list", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);

    const card = page.getByRole("button", { name: /^Team channels/ });
    await expect(card).toHaveCount(1);
    await card.click();
    await expect(page.getByLabel("New channel type")).toBeVisible();
  });
});

test.describe("no control inside these cards is anonymous", () => {
  const CARDS: [string, (page: Page) => Promise<Locator>][] = [
    [
      "the MCP connections card",
      async (page) => {
        await pmSection(page);
        return card(page, "MCP connections");
      },
    ],
    [
      "an expanded team-channels card",
      async (page) => {
        await openConnection(page, /^Team channels/);
        await expect(page.getByLabel("New channel type")).toBeVisible();
        return card(page, "Connections");
      },
    ],
    [
      "an expanded webhooks card",
      async (page) => {
        await openConnection(page, /^Webhooks/);
        await expect(page.getByLabel("New webhook URL")).toBeVisible();
        return card(page, "Connections");
      },
    ],
    [
      "the worker policy card",
      async (page) => {
        await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
        await expect(page.getByLabel("Base branch", { exact: true })).toBeVisible();
        return card(page, "How work is done here");
      },
    ],
  ];

  for (const [where, open] of CARDS) {
    test(where, async ({ page }) => {
      await withTwoOfEverything();
      await signIn(page);
      const scope = await open(page);

      const { examined, nameless } = await namelessControls(scope);
      expect(examined.length, `no controls found in ${where} — the fixture, not the page`)
        .toBeGreaterThan(0);
      expect(nameless, `${examined.length} controls examined in ${where}`).toEqual([]);
    });
  }
});

test("the per-server switches are still the same name on every row", async ({ page }) => {
  await withTwoOfEverything();
  await signIn(page);
  await pmSection(page);

  await expect(page.getByRole("switch", { name: "Enabled", exact: true })).toHaveCount(2);
  await expect(page.getByRole("switch", { name: "Allow writes", exact: true })).toHaveCount(2);
});
