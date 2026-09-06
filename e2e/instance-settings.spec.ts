import { test, expect, type Locator, type Page } from "@playwright/test";
import { SAME_ORIGIN } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  seed,
  seedSecondProject,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

/**
 * BP-394. The settings a person changes about the instance and about themselves: the model the
 * whole instance generates tasks with, their own password, their API tokens, the board preference,
 * the theme, and the address the mail screen sends to.
 *
 * Every one of these is a setting, which means the only assertion worth making is that it took
 * effect somewhere other than the field it was typed into. A value read back out of its own form
 * proves the form. So the token has to authenticate a real request, the password has to sign
 * somebody in, the preference has to change the board, and the theme has to change a painted
 * colour.
 *
 * One clause of the task has no counterpart in the code, and is covered as what exists rather than
 * as what was asked for:
 *
 * - **Configuring SMTP.** The screen says so itself: "Configured in the environment, not here."
 *   Its configured branch needs `SMTP_HOST` for the whole run, which would turn
 *   `email-on-account.spec.ts`'s unconfigured-state assertion red. So that branch sits behind the
 *   same guard inverted, and what runs everywhere is the part needing no mail server: who the test
 *   message would go to, and the profile round trip that decides it.
 *
 * Every assertion here was watched failing against a deliberately broken copy of the code it
 * covers, in three flavours, because they ask different questions. Removing a clause: the model
 * never written, the instance's cap range check gone, the address change no longer needing a
 * password, the name never written, a blank name accepted. Inverting a condition: the password
 * never actually compared, the board ignoring the preference. Swapping the operation: the new
 * password never stored, Revoke answering ok without deleting, the theme choice never persisted.
 * Ten for ten, and three of them only started failing after the assertions they broke were added —
 * the screen-side refusals said nothing about the instance, and the theme survived a reload
 * because Playwright emulates a light OS preference, which is what an unremembered choice falls
 * back to.
 */

test.beforeEach(seed);

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

/**
 * Next's development overlay mounts a portal over the bottom-left corner, which is where the
 * account menu lives. It is not part of the product — `next start` never renders it — so it is
 * taken out of the way rather than clicked around.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/**
 * Opens a screen and waits for it to stop fetching before anything is typed into it.
 *
 * These screens read their values after mounting, and in development React invokes that effect
 * twice — so a value typed between the two answers is overwritten by the later one, and the screen
 * then saves what was already there. Waiting for the traffic to stop is what orders "loaded" before
 * "typed"; without it the failure is a field that silently reverts, which reads as a product bug.
 */
async function openSettled(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function reloadSettled(page: Page) {
  await page.reload();
  await page.waitForLoadState("networkidle");
}

/**
 * Fills a field and makes sure the value is still there afterwards.
 *
 * Two different races made this necessary, and both cost a flake before they were understood. The
 * profile's password prompt appears the moment the address differs, and appearing shifts the ids
 * around it, so Playwright's own retry gives up when the node is replaced while it types. The
 * settings screens have the mirror-image problem: they load their values after mount, and in
 * development React runs that effect twice — a value typed between the two answers is overwritten
 * by the later one, and the screen then saves what was already there.
 *
 * Retried as a whole and read back, so a dropped keystroke fails here rather than as a puzzling
 * success three lines later.
 */
async function fillStably(field: Locator, value: string) {
  await expect(async () => {
    await field.fill(value, { timeout: 3_000 });
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Toasts clear themselves after three seconds, which is shorter than a poll interval — so they are
 * collected as they are added rather than looked for afterwards. Same trick as
 * `kanban-board-core.spec.ts`, and for the same reason.
 */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const added = node.matches('[data-testid="toast"]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-testid="toast"]'));
      for (const toast of added) seen.push(toast.textContent ?? "");
    };
    new MutationObserver((records) =>
      records.forEach((record) => record.addedNodes.forEach(collect))
    ).observe(document.body, { childList: true, subtree: true });
  });
}

function expectToast(page: Page, message: string) {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts))
    .toContain(message);
}

const settingsWrite = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      new URL(r.url()).pathname === "/api/settings" &&
      r.status() === 200
  );

test("an instance setting is stored, and a value the instance will not take is refused", async ({
  page,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await openSettled(page, "/settings/agents");
  await recordToasts(page);

  const model = page.getByLabel("Model", { exact: true });
  await expect(model).toHaveValue("gpt-4o-mini");

  await test.step("a new model is saved and is still there after a reload", async () => {
    const saved = settingsWrite(page);
    await fillStably(model, "gpt-4o-mini-2026");
    await page.getByRole("button", { name: "Save model" }).click();
    await saved;
    await expectToast(page, "Model saved");

    await reloadSettled(page);
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-4o-mini-2026");
  });

  // The control on the step above: a screen that saves everything it is given passes that one and
  // fails this, and a screen that saves nothing fails that one and passes this.
  await test.step("a blank model is refused and nothing is written", async () => {
    await recordToasts(page);
    await fillStably(page.getByLabel("Model", { exact: true }), "   ");
    await page.getByRole("button", { name: "Save model" }).click();
    await expectToast(page, "Give the model a name, or the AI task generator has nothing to call.");

    await reloadSettled(page);
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-4o-mini-2026");
  });

  await test.step("the PM defaults are stored, and a cap outside the range is not", async () => {
    await recordToasts(page);
    const saved = settingsWrite(page);
    await fillStably(page.getByLabel("Default model"), "e2e/instance-default");
    await fillStably(page.getByLabel("Default daily turn cap"), "25");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await saved;

    await reloadSettled(page);
    await expect(page.getByLabel("Default model")).toHaveValue("e2e/instance-default");
    await expect(page.getByLabel("Default daily turn cap")).toHaveValue("25");

    await recordToasts(page);
    await fillStably(page.getByLabel("Default daily turn cap"), "1001");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expectToast(page, "Default turn cap must be a whole number between 0 and 1000");

    await reloadSettled(page);
    await expect(page.getByLabel("Default daily turn cap")).toHaveValue("25");
  });

  // The screen refuses that cap before it sends anything, so the screen is all the step above can
  // speak for. The instance has to refuse it too, and only a request the screen cannot make asks
  // it that. Sent through the browser's own session, because this route reads a cookie.
  await test.step("the instance refuses it as well, not just the screen", async () => {
    const refused = await page.request.put("/api/settings", {
      headers: SAME_ORIGIN,
      data: { pmDefaultDailyTurnCap: 1001 },
    });
    expect(refused.status()).toBe(400);

    const accepted = await page.request.put("/api/settings", {
      headers: SAME_ORIGIN,
      data: { pmDefaultDailyTurnCap: 30 },
    });
    expect(accepted.status()).toBe(200);
  });
});

test("changing your own password: the new one signs in and the old one stops", async ({
  browser,
}) => {
  const NEW_PASSWORD = "e2e-changed-password";

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto("/settings/security");
  await recordToasts(page);

  await test.step("the wrong current password is refused, in the server's words", async () => {
    await page.getByLabel("Current password").fill("not-the-password");
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Current password is incorrect")).toBeVisible();
  });

  await test.step("the right one is accepted", async () => {
    const changed = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === "/api/users/me/password" &&
        r.status() === 200
    );
    await page.getByLabel("Current password").fill(MEMBER_PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await changed;
    await expectToast(page, "Password changed");
  });

  // Where the setting has to show up. A screen that reported success without writing anything
  // satisfies everything above this step.
  await test.step("a fresh browser signs in with the new password and not the old", async () => {
    const other = await browser.newContext();
    const fresh = await other.newPage();

    await fresh.goto("/login");
    await fresh.getByLabel("Username").fill(MEMBER_USERNAME);
    await fresh.getByLabel("Password").fill(MEMBER_PASSWORD);
    await fresh.getByRole("button", { name: "Sign In" }).click();
    await expect(fresh).toHaveURL(/\/login/);

    // The form, deliberately: this step exists to prove the new password works, and a seeded
    // session would sign in without ever presenting it
    await signInThroughForm(fresh, MEMBER_USERNAME, NEW_PASSWORD);
    await other.close();
  });

  await context.close();
});

const TOKEN_NAME = "e2e minted in the browser";
const SCOPED_TOKEN_NAME = "e2e narrowed to one board";

/** One row of the token list, by the name it was given. */
function tokenRow(page: Page, name: string) {
  return page.locator("div.rounded-lg").filter({ hasText: name }).last();
}

/**
 * The one clause of this task that cannot be satisfied by a form: a token is only a token if it
 * authenticates something. The same request is sent twice with the same credential — once while it
 * exists and once after the Revoke button — so neither half can be explained by the request being
 * wrong.
 */
test("a token created here works at once, and stops the moment it is revoked", async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await openSettled(page, "/settings/tokens");
  await recordToasts(page);

  // The fixture already gives this account a token, so the interesting number is not "one" but
  // "one more" — and, after the revoke, exactly one fewer.
  const revokeButtons = page.getByRole("button", { name: "Revoke" });
  await expect(revokeButtons).toHaveCount(1);

  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/tokens" &&
      r.status() < 400
  );
  await page.getByPlaceholder("Token name (e.g. MCP Server, CI)").fill(TOKEN_NAME);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await created;

  // Shown once and never again, which is why it is read off the screen rather than the API
  const secret = (await page.locator("code.select-all").innerText()).trim();
  expect(secret).toMatch(/^cp_[0-9a-f]{40}$/);

  const asToken = { ...SAME_ORIGIN, Authorization: `Bearer ${secret}` };
  const board = `/api/projects/${PROJECT_KEY}`;

  await test.step("it authenticates a real request", async () => {
    const res = await request.get(board, { headers: asToken });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe(PROJECT_NAME);
  });

  await test.step("the list shows it, by prefix and scope, without the secret", async () => {
    await expect(tokenRow(page, TOKEN_NAME)).toBeVisible();
    await expect(tokenRow(page, TOKEN_NAME).getByText(`${secret.slice(0, 11)}...`)).toBeVisible();
    await expect(tokenRow(page, TOKEN_NAME).getByText("· All projects")).toBeVisible();
    await expect(tokenRow(page, TOKEN_NAME)).not.toContainText(secret);
  });

  await test.step("revoking it takes the credential away", async () => {
    const revoked = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        new URL(r.url()).pathname === "/api/tokens" &&
        r.status() === 200
    );
    await tokenRow(page, TOKEN_NAME).getByRole("button", { name: "Revoke" }).click();
    await revoked;
    await expectToast(page, "Token revoked");

    await expect(tokenRow(page, TOKEN_NAME)).toHaveCount(0);
    // Exactly one fewer: a Revoke wired to the wrong row, or to all of them, lands elsewhere
    await expect(revokeButtons).toHaveCount(1);
    await expect(page.getByText("e2e mcp")).toBeVisible();

    const res = await request.get(board, { headers: asToken });
    expect(res.status()).toBe(401);
  });
});

/**
 * BP-473. The checkbox list beside the name is the only way a person narrows a token, and it is
 * the half of the scope nothing drives: `mcp-oauth.spec.ts` covers the OAuth analogue, which
 * reaches the same `applyTokenScope`, and neither of them goes through this form.
 *
 * Minted by an **instance admin** on purpose. `decide()` refuses a board outside the scope on its
 * first line, before the instance-admin branch two lines down (`src/lib/grants.ts:38`) — so the
 * refusal below can only be the scope. Given to a member instead, the same 403 would be explained
 * by the missing grant and the scope would never be examined.
 */
test("a token narrowed to one board is refused on the other, and the row says which", async ({
  page,
  request,
}) => {
  // The board this account can reach and the token cannot. Seeded before the page loads, because
  // the checkbox list is drawn from what the browser was told exists.
  await seedSecondProject();

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await openSettled(page, "/settings/tokens");

  await page.getByPlaceholder("Token name (e.g. MCP Server, CI)").fill(SCOPED_TOKEN_NAME);
  await expect(page.getByRole("checkbox", { name: SECOND_PROJECT_NAME })).toBeVisible();
  await page.getByRole("checkbox", { name: PROJECT_NAME }).check();

  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/tokens" &&
      r.status() < 400
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await created;

  const secret = (await page.locator("code.select-all").innerText()).trim();
  const asToken = { ...SAME_ORIGIN, Authorization: `Bearer ${secret}` };

  await test.step("the board it was given answers it", async () => {
    const res = await request.get(`/api/projects/${PROJECT_KEY}`, { headers: asToken });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).name).toBe(PROJECT_NAME);
  });

  await test.step("the board it was not, refuses it", async () => {
    const res = await request.get(`/api/projects/${SECOND_PROJECT_KEY}`, { headers: asToken });
    expect(res.status()).toBe(403);
  });

  // What the ticking was for, read back where somebody would look for it: the row that used to say
  // "All projects" for a token this wide
  await expect(tokenRow(page, SCOPED_TOKEN_NAME).getByText(`\u00b7 ${PROJECT_KEY}`)).toBeVisible();
  await expect(tokenRow(page, SCOPED_TOKEN_NAME)).not.toContainText("All projects");
});

test("the collapse preference decides what the board does with its empty columns", async ({
  page,
}) => {
  // Several seeded columns never hold a task, so there is something to collapse and something to
  // leave alone
  const EMPTY_COLUMN = "Ready to Test";
  const FULL_COLUMN = "In Progress";
  const board = `/projects/${PROJECT_KEY}`;
  const collapsedRails = page.getByRole("button", { name: /^Expand / });

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  // The control, and the fixture's own state: seeded accounts have the preference off, so every
  // column is full width. Without this the assertion below cannot tell a preference that works
  // from a board that always collapses.
  await test.step("with the preference off no column is a rail", async () => {
    await page.goto(board);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await expect(collapsedRails).toHaveCount(0);
  });

  await test.step("turning it on collapses the empty ones and only those", async () => {
    await openSettled(page, "/settings/preferences");
    await recordToasts(page);
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === "/api/users/me" &&
        r.status() === 200
    );
    await page.getByLabel("Collapse empty columns").check();
    await saved;
    await expectToast(page, "Preference saved");

    await page.goto(board);
    await expect(page.getByRole("button", { name: `Expand ${EMPTY_COLUMN}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Expand ${FULL_COLUMN}` })).toHaveCount(0);
  });

  await test.step("it belongs to the account, not the page, so it survives a reload", async () => {
    await reloadSettled(page);
    await expect(page.getByRole("button", { name: `Expand ${EMPTY_COLUMN}` })).toBeVisible();

    await openSettled(page, "/settings/preferences");
    await expect(page.getByLabel("Collapse empty columns")).toBeChecked();
  });
});

/** What the page actually paints, which is the only thing a reader can see. */
const paintedBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("the theme follows the choice, and the choice survives a reload", async ({ page }) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  // The only test here that reads the shell rather than a settings screen, so it is the only one
  // that has to say where it is: signIn sets a cookie and navigates nowhere.
  await page.goto("/projects");
  await hideDevOverlay(page);

  // Choosing does not close the menu, so a second choice must not toggle it shut on the way in
  async function chooseTheme(name: "Light" | "Dark") {
    const group = page.getByRole("group", { name: "Theme" });
    const accountMenu = page.getByRole("button", { name: /E2E Admin/ });
    // Whether the menu is already open cannot be read before one of the two is on screen: an
    // isVisible() during a re-render answers false, clicks the account button, and closes the
    // menu the choice was about to be made in — which is the very thing the comment above warns
    // against.
    await expect(group.or(accountMenu).first()).toBeVisible();
    if (!(await group.isVisible())) {
      await accountMenu.click();
      await expect(group).toBeVisible();
    }
    await group.getByRole("button", { name, exact: true }).click();
  }

  await chooseTheme("Light");
  const light = await paintedBackground(page);

  await chooseTheme("Dark");
  const dark = await paintedBackground(page);

  // Asserted on the painted colour rather than on `data-theme`, because the attribute can survive
  // a stylesheet that has stopped reading it — and then "the theme persisted" means only that a
  // string persisted.
  expect(dark, "light and dark paint the same background").not.toBe(light);

  // Dark is the one carried across the reload, and that is the whole point: Playwright emulates an
  // OS preference of light, so "system" — what an unremembered choice falls back to — resolves to
  // light. Only something stored can produce dark here. Asserting the light choice instead would
  // pass with the persistence deleted.
  await page.reload();
  await hideDevOverlay(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await paintedBackground(page)).toBe(dark);

  await page.goto(`/projects/${PROJECT_KEY}`);
  await hideDevOverlay(page);
  expect(await paintedBackground(page)).toBe(dark);
});

test("the profile: the name lands in the shell, the address is guarded by the password", async ({
  page,
}) => {
  const ADDRESS = "e2e-admin@example.test";
  const NEW_NAME = "E2E Admin Renamed";

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  await test.step("the mail screen has nowhere to send until there is an address", async () => {
    await page.goto("/settings/email");
    await expect(page.getByText("No mail server is configured.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a test message" })).toBeDisabled();
    await expect(page.getByText(/Add an address to/)).toBeVisible();
  });

  await openSettled(page, "/settings/profile");
  await recordToasts(page);

  // Scoped to the page body: the sidebar prints this account's name and its role in the corner, so
  // an unscoped "admin" or "E2E Admin" matches the furniture as well as the field.
  await test.step("the profile names the account it belongs to, and cannot rename it away", async () => {
    const main = page.locator("#main-content");
    await expect(main.getByText(ADMIN_USERNAME, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Full Name")).toHaveValue("E2E Admin");

    await fillStably(page.getByLabel("Full Name"), "   ");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await fillStably(page.getByLabel("Full Name"), "E2E Admin");
  });

  // The name is the one field here with no password gate — it receives no reset link — so what has
  // to be shown is simply that it lands somewhere other than its own input. The shell is that
  // somewhere: it renders the cached account, which is why saving refreshes it.
  await test.step("a new name reaches the shell and survives a reload", async () => {
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === "/api/users/me" &&
        r.status() === 200
    );
    await fillStably(page.getByLabel("Full Name"), NEW_NAME);
    await page.getByRole("button", { name: "Save" }).click();
    await saved;
    await expectToast(page, "Profile updated");

    await expect(page.getByRole("button", { name: new RegExp(NEW_NAME) })).toBeVisible();

    await reloadSettled(page);
    await expect(page.getByLabel("Full Name")).toHaveValue(NEW_NAME);
    await expect(page.getByRole("button", { name: new RegExp(NEW_NAME) })).toBeVisible();
  });

  // The blank name is refused by the button above, so the button is all that step can speak for.
  // Only a request the screen cannot make asks the instance the same question.
  await test.step("the instance refuses a blank name as well, not just the button", async () => {
    const refused = await page.request.put("/api/users/me", {
      headers: SAME_ORIGIN,
      data: { fullName: "  " },
    });
    expect(refused.status()).toBe(400);

    await reloadSettled(page);
    await expect(page.getByLabel("Full Name")).toHaveValue(NEW_NAME);
  });

  await test.step("a new address without the right password is refused", async () => {
    // Re-armed after the reloads above: the observer that collects toasts does not survive one
    await recordToasts(page);
    await fillStably(page.getByLabel("Email"), ADDRESS);
    await fillStably(page.getByLabel("Current password"), "not-the-password");
    await page.getByRole("button", { name: "Save" }).click();
    await expectToast(page, "Current password is incorrect");

    await reloadSettled(page);
    await expect(page.getByLabel("Email")).toHaveValue("");
  });

  await test.step("with the right password it is stored", async () => {
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === "/api/users/me" &&
        r.status() === 200
    );
    await recordToasts(page);
    await fillStably(page.getByLabel("Email"), ADDRESS);
    await fillStably(page.getByLabel("Current password"), ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Save" }).click();
    await saved;
    await expectToast(page, "Profile updated");

    await reloadSettled(page);
    await expect(page.getByLabel("Email")).toHaveValue(ADDRESS);
  });

  // The Save button is disabled without a password, so the screen can never ask this. The route
  // has to answer it anyway: the address is where a reset link lands, and a borrowed session that
  // could repoint it silently would keep the account for good.
  await test.step("the route refuses an address change that brings no password at all", async () => {
    const refused = await page.request.put("/api/users/me", {
      headers: SAME_ORIGIN,
      data: { email: "somewhere-else@example.test" },
    });
    expect(refused.status()).toBe(400);

    await reloadSettled(page);
    await expect(page.getByLabel("Email")).toHaveValue(ADDRESS);
  });

  // Where that address shows up somewhere other than its own field
  await test.step("the mail screen now names it as the destination", async () => {
    await page.goto("/settings/email");
    await expect(
      page.getByText(`It goes to ${ADDRESS}, the address on your profile.`)
    ).toBeVisible();
  });
});

/**
 * The configured branch of the mail screen. Skipped where there is no mail server, which is CI and
 * every developer machine here — and stated rather than silently passed, because the alternative
 * is setting SMTP_HOST for the whole run, which turns `email-on-account.spec.ts`'s
 * unconfigured-state assertion red.
 */
test("the mail screen reports the server it was given", async ({ page }) => {
  test.skip(!process.env.SMTP_HOST, "needs a mail server; this run has none");

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/email");

  await expect(page.getByText(String(process.env.SMTP_HOST), { exact: false })).toBeVisible();
  await expect(page.getByText("No mail server is configured.")).toHaveCount(0);
});
