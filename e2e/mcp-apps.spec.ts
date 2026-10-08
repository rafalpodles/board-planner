import { test, expect, type Page } from "@playwright/test";
import { McpSession } from "./mcp";
import { API_TOKEN, PROJECT_KEY, SIBLING_TASK_KEY, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE, HELD_TASK_KEY, SOURCE_COLUMN, TARGET_COLUMN, seed, storedTask } from "./seed";
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

test.beforeEach(async () => { await seed(); });

/** A small MCP Apps host, forwarding every tools/call to the real authenticated /api/mcp.
 * The iframe has no credential. Its HTML comes from resources/read, not a test copy of the UI.
 */
async function host(page: Page, session: McpSession, tool: string, args: Record<string, unknown>, theme = "light", interactive = true) {
  const discovered = await session.call("tools/list");
  const tools = discovered.body.result?.tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[];
  const uri = tools.find((t) => t.name === tool)?._meta?.ui?.resourceUri;
  expect(uri).toMatch(/^ui:\/\//);
  const read = await session.call("resources/read", { uri });
  const content = (read.body.result?.contents as { text: string; mimeType: string; _meta: unknown }[])[0];
  expect(content.mimeType).toBe("text/html;profile=mcp-app");
  expect(content.text).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/);
  const initial = await session.callTool(tool, args);
  expect(initial.raw.result?.isError, initial.text).not.toBe(true);
  await page.exposeFunction("forwardTool", async (params: { name: string; arguments: Record<string, unknown> }) => {
    const called = await session.callTool(params.name, params.arguments);
    expect(called.status, called.text).toBe(200);
    return called.raw.result;
  });
  const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0"><script>
    window.calls = []; window.links = []; window.ready = false;
    const frame = document.createElement('iframe'); frame.title = 'Board Planner App';
    frame.style = 'width:100%;height:900px;border:0'; frame.sandbox = 'allow-scripts';
    window.send = (method, params) => frame.contentWindow.postMessage({jsonrpc:'2.0', method, params}, '*');
    window.addEventListener('message', async (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message.method === 'ui/notifications/initialized') {
        window.ready = true;
        window.send('ui/notifications/tool-input', {arguments: ${scriptJson(args)}});
        window.send('ui/notifications/tool-result', ${scriptJson(initial.raw.result)});
        return;
      }
      if (message.id == null) return;
      let result;
      if (message.method === 'ui/initialize') result = {protocolVersion:'2026-01-26',hostInfo:{name:'e2e-host',version:'1'},hostCapabilities:{${interactive ? 'serverTools:{},' : ''}openLinks:{}},hostContext:{theme:${scriptJson(theme)},displayMode:'inline'}};
      else if (message.method === 'tools/call') { window.calls.push(message.params); result = await window.forwardTool(message.params); }
      else if (message.method === 'ui/open-link') { window.links.push(message.params.url); result = {}; }
      else result = {};
      frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result}, '*');
    });
    frame.srcdoc = ${scriptJson(content.text.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">`))}; document.body.append(frame);
  </script></body></html>`;
  await page.route("http://mcp-apps.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://mcp-apps.test/");
  await expect.poll(() => page.evaluate(() => (window as unknown as { ready: boolean }).ready)).toBe(true);
  return page.frameLocator("iframe");
}
async function sessionFor(page: Page) {
  const session = new McpSession(page.request, API_TOKEN);
  await session.open(); // Advertises no Apps capability: text-only clients still get exactly the same JSON.
  return session;
}

test("task card uses real writes, reflects checklist and status, and follows host theme", async ({ page }) => {
  const session = await sessionFor(page);
  await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, description: "**Release** details\n\n<script>window.bad = true</script>", acceptanceCriteria: "- [ ] Ships the card" });
  const card = await host(page, session, "get_task", { taskKey: SIBLING_TASK_KEY });
  await expect(card.getByRole("heading", { name: SIBLING_TASK_TITLE })).toBeVisible();
  await expect(card.locator("strong", { hasText: "Release" })).toBeVisible();
  await expect(card.locator(".description script")).toHaveCount(0);
  const criterion = card.getByRole("checkbox", { name: "Ships the card" });
  await criterion.click();
  await expect.poll(async () => ((await storedTask(SIBLING_TASK_NUMBER))?.checklist as { done: boolean }[])?.[0]?.done).toBe(true);
  await expect(criterion).toBeChecked();
  await expect(card.getByRole("combobox", { name: "Task status" })).toBeEnabled();
  await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, description: "**Release** details\n\nThe task card now supports status changes and acceptance criteria, directly in the conversation." });
  await card.getByRole("combobox", { name: "Task status" }).selectOption(TARGET_COLUMN.id);
  await expect.poll(async () => (await storedTask(SIBLING_TASK_NUMBER))?.status).toBe(TARGET_COLUMN.id);
  await expect(card.getByRole("combobox")).toHaveValue(TARGET_COLUMN.id);
  await expect(card.locator("html")).toHaveAttribute("data-theme", "light");
  await card.locator("#root").screenshot({ path: test.info().outputPath("task-light.png") });
  await page.evaluate(() => (window as unknown as { send: Function }).send("ui/notifications/host-context-changed", { theme: "dark" }));
  await expect(card.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => card.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  await card.locator("#root").screenshot({ path: test.info().outputPath("task-dark-phone.png") });
  await card.getByRole("link", { name: "Open in Board Planner" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { links: string[] }).links)).toEqual([expect.stringContaining(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`)]);
});

test("a refused write stays visible and leaves the card in its saved status", async ({ page }) => {
  const session = await sessionFor(page);
  const card = await host(page, session, "get_task", { taskKey: HELD_TASK_KEY });
  await expect(card.getByRole("combobox")).toBeEnabled();
  await card.getByRole("combobox").selectOption(TARGET_COLUMN.id);
  await expect(card.getByRole("alert")).toContainText("worker");
  await expect(card.getByRole("combobox")).toHaveValue(SOURCE_COLUMN.id);
  expect((await storedTask(SIBLING_TASK_NUMBER))?.status).toBe(SOURCE_COLUMN.id);
});

for (const tool of ["list_tasks", "my_tasks", "search_tasks"]) {
  test(`${tool} opens a full card from a row`, async ({ page }) => {
    const session = await sessionFor(page);
    if (tool === "my_tasks") await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, assignee: "admin" });
    const args = tool === "list_tasks" ? { project: PROJECT_KEY, limit: 1 } : tool === "search_tasks" ? { query: SIBLING_TASK_KEY } : {};
    const list = await host(page, session, tool, args, "dark");
    await expect(list.getByRole("region", { name: "Board Planner" })).toBeVisible();
    const row = list.getByRole("button", { name: new RegExp(SIBLING_TASK_KEY) });
    // The first page's order belongs to the API: find the requested task on later pages if necessary.
    if (tool === "list_tasks") {
      for (let i = 0; i < 4; i++) {
        await expect(list.locator("main")).toHaveAttribute("aria-busy", "false");
        if (await row.count()) break;
        await list.getByRole("button", { name: "Next page" }).click();
      }
    }
    await row.click();
    await expect(list.getByRole("heading", { name: SIBLING_TASK_TITLE })).toBeVisible();
    await list.getByRole("button", { name: "Back" }).click();
    await expect(row).toBeVisible();
  });
}

for (const tool of ["create_task", "update_task", "change_task_status"]) {
  test(`${tool} minimal result shows the resulting full card`, async ({ page }) => {
    const session = await sessionFor(page);
    const args = tool === "create_task" ? { project: PROJECT_KEY, title: "Widget-created task", description: "Created description", minimal: true } : tool === "update_task" ? { taskKey: SIBLING_TASK_KEY, description: "Changed description", minimal: true } : { taskKey: SIBLING_TASK_KEY, status: TARGET_COLUMN.id, minimal: true };
    const card = await host(page, session, tool, args);
    await expect(card.getByRole("heading", { name: tool === "create_task" ? "Widget-created task" : SIBLING_TASK_TITLE })).toBeVisible();
    if (tool !== "change_task_status") await expect(card.getByRole("region", { name: "Description" })).toContainText(tool === "create_task" ? "Created description" : "Changed description");
    else await expect(card.getByRole("combobox")).toHaveValue(TARGET_COLUMN.id);
  });
}

test("stats and sprint views show real counts and sprint navigation", async ({ page }) => {
  const session = await sessionFor(page);
  const stats = await host(page, session, "get_project_stats", { project: PROJECT_KEY });
  await expect(stats.getByRole("heading", { name: "Status distribution" })).toBeVisible();
  await expect(stats.getByRole("progressbar")).toHaveAttribute("max", "4");
  // A fresh page gets a fresh host binding and iframe.
  const sprint = await session.callTool("create_sprint", { project: PROJECT_KEY, name: "Widget sprint", startDate: "2026-10-01", endDate: "2026-10-15" });
  await session.callTool("update_task", { taskKey: SIBLING_TASK_KEY, sprint: sprint.parsed._id });
  const next = await page.context().newPage();
  const list = await host(next, session, "list_sprints", { project: PROJECT_KEY });
  await expect(list.getByText("0 of 1 done")).toBeVisible();
  await list.getByRole("button", { name: "Widget sprint" }).click();
  await expect(list.getByRole("heading", { name: "Widget sprint" })).toBeVisible();
  await expect(list.getByRole("button", { name: new RegExp(SIBLING_TASK_KEY) })).toBeVisible();
  await next.close();
});

test("a host without tool interactions still renders the task", async ({ page }) => {
  const session = await sessionFor(page);
  const original = await session.callTool("get_task", { taskKey: SIBLING_TASK_KEY });
  expect(original.parsed.title).toBe(SIBLING_TASK_TITLE);
  const card = await host(page, session, "get_task", { taskKey: SIBLING_TASK_KEY }, "light", false);
  await expect(card.getByRole("heading", { name: SIBLING_TASK_TITLE })).toBeVisible();
  await expect(card.getByRole("combobox")).toBeDisabled();
  await expect(card.getByText("This host displays the view without tool interactions.")).toBeVisible();
});
