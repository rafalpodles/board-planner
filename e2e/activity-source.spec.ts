import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import { PROJECT_ID, PROJECT_KEY, SIBLING_TASK_ID, SIBLING_TASK_NUMBER, insertLegacyEntries, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-824: every comment and history entry says where it came from — the web app, the PM agent, an
 * MCP client, a bare API token, or a time before sources were kept — and a browser session cannot
 * dress up as anything else.
 */

const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const COMMENTS = `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`;

test.beforeEach(seed);

async function callMcp(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const response = await request.post("/api/mcp", {
    headers: { ...ADMIN_AUTH, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function commentCard(page: Page, body: string): Promise<Locator> {
  const panel = page.getByRole("tabpanel", { name: /Comments/ });
  await expect(panel.getByText(body, { exact: true })).toBeVisible();
  return panel
    .locator("div")
    .filter({ has: page.getByText(body, { exact: true }) })
    .filter({ has: page.getByTestId("source-badge") })
    .last();
}

async function expectSource(scope: Locator, source: string, title: RegExp) {
  const badge = scope.getByTestId("source-badge");
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute("data-source", source);
  await expect(badge).toHaveAttribute("title", title);
}

async function openHistory(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel.getByRole("time").first()).toBeVisible();
  const showAll = panel.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible()) await showAll.click();
  return panel;
}

const historyRow = (panel: Locator, text: string | RegExp) =>
  panel.locator("div.flex.items-start").filter({ hasText: text });

test("each comment and history entry says where it came from", async ({ page, request }) => {
  await insertLegacyEntries(SIBLING_TASK_ID, "Written before sources were kept");

  const byToken = await request.post(COMMENTS, { headers: ADMIN_AUTH, data: { body: "Posted with an API token" } });
  expect(byToken.status()).toBe(201);
  await callMcp(request, "add_comment", { taskKey: TASK_KEY, body: "Posted through MCP" });
  await callMcp(request, "update_task", { taskKey: TASK_KEY, priority: "urgent" });

  await signIn(page);
  await page.goto(TASK_URL);
  const box = page.getByRole("textbox", { name: "Write a comment, @mention someone…" });
  await box.fill("Typed in the browser");
  await expect(box).toHaveValue("Typed in the browser");
  const posted = page.waitForResponse(
    (r) => /\/tasks\/[^/]+\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  expect((await posted).status()).toBe(201);

  // The header the MCP server sends, from a person's own session: the session wins
  const claimed = await page.request.post(COMMENTS, {
    headers: { ...SAME_ORIGIN, "x-bp-client": "mcp" },
    data: { body: "A session claiming to be MCP" },
  });
  expect(claimed.status()).toBe(201);

  await page.reload();
  await expectSource(await commentCard(page, "Typed in the browser"), "web-ui", /^Through the web app$/);
  await expectSource(await commentCard(page, "A session claiming to be MCP"), "web-ui", /^Through the web app$/);
  await expectSource(await commentCard(page, "Posted through MCP"), "mcp", /^Through MCP/);
  await expectSource(await commentCard(page, "Posted with an API token"), "api", /^Through the API/);
  await expectSource(await commentCard(page, "Written before sources were kept"), "legacy", /before Board Planner kept/);

  const history = await openHistory(page);
  await expectSource(historyRow(history, /changed priority from \w+ to Urgent/i), "mcp", /^Through MCP/);
  await expectSource(historyRow(history, /changed priority from low to medium/), "legacy", /before Board Planner kept/);
  await expect(historyRow(history, "added a comment").getByTestId("source-badge")).toHaveCount(4);
  for (const source of ["web-ui", "mcp", "api"]) {
    await expect(history.locator(`[data-testid="source-badge"][data-source="${source}"]`).first()).toBeVisible();
  }
});

test("what the PM agent writes is marked as the agent's, not the person's who asked", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  const call = { name: "add_comment", arguments: { taskKey: TASK_KEY, body: "Left by the PM agent" } };
  await page.getByPlaceholder(/Message the PM/).fill(`Please note this on the task. <<${JSON.stringify(call)}>>`);
  const commented = page.waitForResponse((r) => r.url().includes("/pm/chat") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await commented;

  await expect
    .poll(async () => {
      const response = await page.request.get(COMMENTS);
      const comments: { body: string; source: string }[] = await response.json();
      return comments.find((c) => c.body === "Left by the PM agent")?.source ?? null;
    })
    .toBe("pm-agent");

  await page.goto(TASK_URL);
  await expectSource(await commentCard(page, "Left by the PM agent"), "pm-agent", /^By the PM agent/);
  const history = await openHistory(page);
  await expectSource(historyRow(history, "added a comment").first(), "pm-agent", /^By the PM agent/);
});
