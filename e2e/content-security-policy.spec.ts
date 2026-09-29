import { test, expect, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-313. script-src used to be 'self' 'unsafe-inline', because a nonce needs a request and
 * next.config has none. A nonce policy that forgets one of Next's own inline scripts does not fail
 * a build or a unit test: the page arrives, its hydration script is refused, and every button is
 * dead. So each page here is loaded in a real browser, under the enforced header, and made to do
 * something only a hydrated page can.
 */

test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;

type Violation = { directive: string; blocked: string; url: string };

async function watchForViolations(page: Page): Promise<{ violations: Violation[]; consoleErrors: string[] }> {
  const violations: Violation[] = [];
  const consoleErrors: string[] = [];
  await page.exposeBinding("__cspViolation", (_source, v: Violation) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation: (v: Violation) => void }).__cspViolation({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        url: e.documentURI,
      });
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /Content.Security.Policy|nonce/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  return { violations, consoleErrors };
}

function policyOf(headers: Record<string, string>): { policy: string; nonce: string } {
  const policy = headers["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
  return { policy, nonce };
}

async function hydrated(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.body.querySelectorAll("*")).some((el) =>
          Object.keys(el).some((k) => k.startsWith("__reactFiber"))
        )
      )
    )
    .toBe(true);
}

test("every script a page is served carries that response's nonce, and no two responses share one", async ({
  page,
}) => {
  await signIn(page);

  const first = await page.request.get(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  const second = await page.request.get(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  const a = policyOf(first.headers());
  const b = policyOf(second.headers());

  expect(a.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(b.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(a.nonce).not.toBe(b.nonce);

  const scriptSrc = a.policy.split("; ").find((d) => d.startsWith("script-src "))!;
  expect(scriptSrc).toContain(`'nonce-${a.nonce}'`);
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(a.policy).toContain("img-src * data: blob:");

  const html = await first.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(1);
  for (const tag of scripts) expect(tag).toContain(`nonce="${a.nonce}"`);

  const themeBootstrap = new RegExp(`<script nonce="${a.nonce.replace(/[+/]/g, "\\$&")}">\\(function\\(\\)\\{try\\{var p=localStorage`);
  expect(html).toMatch(themeBootstrap);
});

test("the theme bootstrap runs before the body exists, under the enforced policy", async ({ page }) => {
  const { violations, consoleErrors } = await watchForViolations(page);
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    new MutationObserver((_, observer) => {
      if (document.documentElement?.hasAttribute("data-theme")) {
        (window as unknown as { __themeSetBeforeBody: boolean }).__themeSetBeforeBody = document.body === null;
        observer.disconnect();
      }
    }).observe(document, { attributes: true, subtree: true, childList: true, attributeFilter: ["data-theme"] });
  });

  const response = await page.goto("/login");
  expect(response!.headers()["content-security-policy"]).toContain("'nonce-");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => (window as unknown as { __themeSetBeforeBody?: boolean }).__themeSetBeforeBody)).toBe(
    true
  );
  await hydrated(page);
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("signing in, the board, a task and settings all hydrate with zero violations", async ({ page }) => {
  const { violations, consoleErrors } = await watchForViolations(page);

  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);

  await page.goto(BOARD);
  await page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  const title = page.getByLabel("Task title");
  await expect(title).toHaveValue(SIBLING_TASK_TITLE);
  await title.fill("Typed after hydration");
  await expect(page).toHaveTitle(/Typed after hydration/);

  for (const path of [`${BOARD}/settings`, "/settings/profile", "/my-tasks", "/forgot"]) {
    await page.goto(path);
    await hydrated(page);
  }

  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// The control: without it, a listener that never fires would pass every "zero violations" above.
// Markup injected into the DOM is what an XSS is, and what 'unsafe-inline' used to let run.
test("an injected inline handler is refused", async ({ page }) => {
  const { violations } = await watchForViolations(page);
  await signIn(page);
  await page.goto(BOARD);
  await hydrated(page);

  await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML = '<img src="data:," onerror="window.__injected = true">';
    document.body.appendChild(host);
  });

  await expect.poll(() => violations.map((v) => v.directive)).toContain("script-src-attr");
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
});

// Chrome delivers Reporting API batches from its network service, out of band and after a delay,
// so the page never sees the request; what can be pinned is that the endpoint takes both shapes.
test("the report endpoint takes both shapes a browser sends", async ({ request }) => {
  const legacy = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({ "csp-report": { "document-uri": "http://localhost/x", "effective-directive": "script-src-elem" } }),
  });
  expect(legacy.status()).toBe(204);
  const batch = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json" },
    data: JSON.stringify([{ type: "csp-violation", body: { documentURL: "http://localhost/x", effectiveDirective: "script-src-attr" } }]),
  });
  expect(batch.status()).toBe(204);
  const other = await request.post("/api/csp-report", { headers: { "content-type": "text/plain" }, data: "x" });
  expect(other.status()).toBe(415);
});
