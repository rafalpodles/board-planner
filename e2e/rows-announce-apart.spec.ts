import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-510. BP-498 gave the MCP auth select a per-row name and stopped there. Every other control in
 * those rows still announced the same on every row: three servers meant three anonymous name
 * inputs and three buttons called "Remove MCP server"; three channels meant three buttons called
 * "Delete" and three toggles whose entire accessible name was their own current state — "Active",
 * which says neither what pressing does nor which row it belongs to.
 *
 * **Two of everything, on purpose.** A name that fails to distinguish rows is invisible with one
 * row: "Delete" is a perfectly good name until there are two of them. Every fixture here seeds a
 * pair, and the assertions are `toHaveCount(1)` rather than `toBeVisible()` so a name shared by
 * both rows fails as a count of 2 instead of passing on the first match.
 *
 * **A placeholder IS a name, which is why the sweep alone would not have caught most of this.**
 * BP-510 says the placeholder-only boxes lose their name "as soon as somebody types". Measured
 * here with `ariaSnapshot`, against this app, with the fix removed: they do not. Chrome falls back
 * to the placeholder and keeps it whatever the field holds —
 *
 *     - textbox "name (slug, e.g. notion)": acme
 *
 * So the defect is not an unnamed control. It is that the name is a *hint* rather than a label
 * (WCAG 3.3.2), that every row carries the identical one, and that the on-screen cue a sighted
 * reader had is gone the moment the field is used. `namelessControls` below cannot see any of
 * that — it finds controls with no name at all, which is what the worker policy inputs were. The
 * per-control assertions are what protect the placeholder-only ones, and reverting any one of
 * them reddens the test that names it.
 *
 * **What this does not cover.** The per-server `Enabled` and `Allow writes` switches still
 * announce identically across rows. `Switch` takes its name from its visible label and offers no
 * way to add the row's name without either changing what is on screen or widening the component,
 * so they were left alone — and `namelessControls` cannot see them either, since they are named,
 * just not apart. Asserted as the known limit in the last test, so the day somebody fixes them
 * this spec goes red and gets updated rather than silently over-claiming.
 */

test.beforeEach(seed);

const CHANNEL_A = "alpha-room";
const CHANNEL_B = "beta-room";
const WEBHOOK_A = "https://example.com/hooks/alpha";
const WEBHOOK_B = "https://example.com/hooks/beta";
// What maskSecretUrl makes of the two above: the origin, the mask, and the last four characters.
// Written out rather than computed, so a change to the masking is a failure here and not a test
// that quietly follows it.
const WEBHOOK_A_MASKED = "https://example.com/••••lpha";
const WEBHOOK_B_MASKED = "https://example.com/••••beta";

/**
 * A second row for each of the four repeated shapes, written straight into the project the way
 * `select-has-a-name.spec.ts` seeds its MCP server: the seed keeps the board every other spec
 * expects, and adding rows there would put channels and webhooks on all of them.
 */
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
        // The `set · reset` button renders only for a field that is pinned, and two of them are
        // what makes "told apart only by position" a failure rather than a description
        "worker.policyOverrides": ["baseBranch", "taskTimeoutMs"],
      },
    }
  );
}

/**
 * Playwright's own accessible-name computation rather than a second implementation of it in the
 * page: `ariaSnapshot` prints one line per node, and a control with a name carries it in quotes.
 * A DOM-level re-derivation would be a different algorithm that agrees with the real one most of
 * the time, which is the worst kind of net.
 *
 * Returns the roles this cares about that came back with no name at all, and how many were seen —
 * a region that renders no controls must not read as a region with no unnamed ones.
 */
const NAMED_ROLES = ["button", "textbox", "combobox", "checkbox", "switch", "link", "searchbox"];

async function namelessControls(scope: Locator) {
  const snapshot = await scope.ariaSnapshot();
  const lines = snapshot.split("\n");
  const examined: string[] = [];
  const nameless: string[] = [];
  for (const line of lines) {
    // `- button "Delete alpha-room"` / `- textbox:` / `- button [disabled]`
    const match = /^\s*-\s+([a-z]+)\b(.*)$/.exec(line);
    if (!match) continue;
    const [, role, rest] = match;
    if (!NAMED_ROLES.includes(role)) continue;
    examined.push(line.trim());
    if (!/"[^"]*\S[^"]*"/.test(rest)) nameless.push(line.trim());
  }
  return { examined, nameless };
}

async function pmSection(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=pm`);
  await expect(page.getByLabel("Authentication for acme")).toBeVisible();
}

/**
 * `SettingsCard` and `Connections` both render a bare `<section>`, which is `generic` rather than
 * `region` until it has a name of its own — so the card has to be reached through the heading
 * inside it rather than by role.
 */
function card(page: Page, heading: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/** Opens one of the Connections rows by the name it announces, which is itself part of the fix. */
async function openConnection(page: Page, name: RegExp) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);
  await page.getByRole("button", { name }).click();
}

test.describe("a settings row says which row it is", () => {
  test("every control in an MCP server row carries that server's name", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await pmSection(page);

    // The control, and the premise: two rows really are on screen, and the two name inputs are
    // different controls holding different values. Reached through the name under test, so a name
    // shared by both rows fails here as a strict-mode violation rather than later as a wrong read.
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

    // A row identifies itself by the name it has now, which is the same rule the auth select has
    // followed since BP-498. Renaming the server renames its neighbours with it — including the
    // remove button, which is the one where getting the wrong row is destructive.
    await page.getByLabel("Name for acme").fill("acme-two");
    await expect(page.getByRole("button", { name: "Remove acme-two" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove acme", exact: true })).toHaveCount(0);
    // The other row is untouched: a single shared name would have moved both
    await expect(page.getByRole("button", { name: "Remove zenith" })).toHaveCount(1);
  });

  test("a channel's delete and event chips name the channel", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await openConnection(page, /^Team channels/);

    await expect(page.getByRole("button", { name: `Delete ${CHANNEL_A}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Delete ${CHANNEL_B}` })).toHaveCount(1);
    // The word alone is what it announced before, on both rows at once
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    await expect(
      page.getByRole("button", { name: `task created for ${CHANNEL_A}` })
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `task created for ${CHANNEL_B}` })
    ).toHaveCount(1);

    // Seeded pressed on one row and not the other, so a hard-coded `aria-pressed` cannot pass
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
    // The premise: the visible word really is the state, and really does change. That word was
    // the whole accessible name until this ticket, so the assertion after it is the point.
    await expect(toggle).toHaveText("Active");

    await toggle.click();

    await expect(toggle).toHaveText("Disabled");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Same locator, still one match: pressing it did not rename it out from under a reader
    await expect(toggle).toHaveCount(1);
    // And it did not take the other row with it
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

    // SecretField renders one of these per row and called every one of them "Replace"
    await expect(
      page.getByRole("button", { name: `Replace URL for ${WEBHOOK_A_MASKED}` })
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Replace", exact: true })).toHaveCount(0);
  });

  test("each policy field names itself, and so does the button that resets it", async ({
    page,
  }) => {
    await withTwoOfEverything();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();

    // The <span> beside each of these was not a label, so the inputs had no name at all.
    // `exact` because the reset button beside each one now names the same field.
    await expect(page.getByLabel("Base branch", { exact: true })).toHaveValue("main");
    await expect(page.getByLabel("Timeout for one step (ms)", { exact: true })).toHaveValue(
      "1800000"
    );

    await expect(
      page.getByRole("button", { name: "Reset Base branch to the default" })
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Reset Timeout for one step (ms) to the default" })
    ).toHaveCount(1);
    // `title` is a tooltip and never became the name; the text content did, on both buttons
    await expect(page.getByRole("button", { name: "set · reset" })).toHaveCount(0);

    // It still resets the field it names, not its neighbour
    await page.getByRole("button", { name: "Reset Base branch to the default" }).click();
    await expect(page.getByRole("button", { name: "Reset Base branch to the default" })).toHaveCount(
      0
    );
    await expect(
      page.getByRole("button", { name: "Reset Timeout for one step (ms) to the default" })
    ).toHaveCount(1);
  });

  test("the task search box keeps its name once somebody types into it", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await page.getByRole("button", { name: "+ Add dependency" }).click();

    const search = page.getByLabel("Search tasks to link");
    await expect(search).toHaveCount(1);
    await expect(search).toHaveAccessibleName("Search tasks to link");

    // Typed into, which is where the placeholder stops being visible. It does NOT stop being the
    // accessible name — see the note at the top of this file — so what this pins is that the box
    // is named by a label of its own rather than by the hint it displays.
    await search.fill("Free");
    await expect(search).toHaveValue("Free");
    await expect(search).toHaveAccessibleName("Search tasks to link");
  });
});

/**
 * The one item in BP-510 that is not about repeated rows, and whose stated cause was wrong. The
 * ticket said the card's title and blurb "sit in elements that contribute no accessible name";
 * they are plain spans and contribute perfectly well. What broke `/^Team channels/` is that
 * `BrandIcon` carried `role="img" aria-label="Slack"` *inside* the button, so the name began with
 * the vendor rather than with the card.
 */
test.describe("a Connections card is announced by its own name", () => {
  test("before anything is connected, in the picker", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);

    const card = page.getByRole("button", { name: /^Team channels/ });
    await expect(card).toHaveCount(1);
    // The specific thing that used to be first, named so the failure says which half broke
    await expect(card).not.toHaveAccessibleName(/^Slack/);
  });

  test("and once it is, in the list", async ({ page }) => {
    await withTwoOfEverything();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);

    // A configured row is a different button in a different branch of Connections — the icon sits
    // outside it there, which is why this half has always worked and is the control for the other
    const card = page.getByRole("button", { name: /^Team channels/ });
    await expect(card).toHaveCount(1);
    await card.click();
    await expect(page.getByLabel("New channel type")).toBeVisible();
  });
});

/**
 * The net under the assertions above. Scoped to the cards rather than the page: a settings screen
 * carries a nav, a header and a save bar, and a sweep that swallowed those would be a different,
 * much larger claim than this ticket makes.
 */
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
      // A card that rendered nothing would satisfy the assertion below without meaning anything
      expect(examined.length, `no controls found in ${where} — the fixture, not the page`)
        .toBeGreaterThan(0);
      expect(nameless, `${examined.length} controls examined in ${where}`).toEqual([]);
    });
  }
});

/**
 * The limit, asserted rather than described. Two servers put two switches called "Enabled" on the
 * screen, and nothing above notices because each one *has* a name — it is just the same name
 * twice. This passes today and is meant to: it goes red the day the switches are fixed, which is
 * when the doc comment at the top of this file stops being true.
 */
test("the per-server switches are still the same name on every row", async ({ page }) => {
  await withTwoOfEverything();
  await signIn(page);
  await pmSection(page);

  await expect(page.getByRole("switch", { name: "Enabled", exact: true })).toHaveCount(2);
  await expect(page.getByRole("switch", { name: "Allow writes", exact: true })).toHaveCount(2);
});
