import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { PM_STUB_URL } from "../playwright.config";
import { CRASH_MARKER, EXPECTED_CRASH_HEADER } from "./stub-guard.mjs";

/**
 * BP-575. The stubs are one process each for a whole run, so a throw inside a request handler used
 * to exit `e2e/openrouter-stub.mjs` and every spec after that point failed on `read ECONNRESET` —
 * wherever the run happened to be, which reads as a different bug each time.
 *
 * The subject here is the harness, not the product, so the killer request is made directly: a
 * malformed `<<…>>` directive is what the stub parses with `JSON.parse`, and it is the throw that
 * was actually killing runs. What has to hold is the pair — the bad request is answered rather
 * than swallowed, and the same process serves the next one.
 *
 * The control is a real PM turn through the chat box afterwards. A stub that answers `/health` and
 * nothing else would satisfy every assertion above it while leaving the run just as dead.
 */

const PM_URL = `/projects/${PROJECT_KEY}/pm`;

const chatBox = (page: Page) => page.getByPlaceholder(/Message the PM/);
const sendButton = (page: Page) => page.getByRole("button", { name: "Send", exact: true });
const reply = (page: Page) => page.getByText("PM Agent", { exact: true }).last().locator("xpath=..");

/** A completion request shaped like the app's, carrying whatever directive the test wants read. */
const completion = (text: string) => ({
  model: "e2e/text-only-model",
  messages: [{ role: "user", content: text }],
});

test.beforeEach(async ({ request }) => {
  await seed();
  await request.post(`${PM_STUB_URL}/reset`);
});

test.describe("a stub that is handed a request it cannot serve", () => {
  test("answers it, says what threw, and serves the next one", async ({ page, request }) => {
    // `JSON.parse(script)` on a directive that is not JSON. Before the guard this exited the
    // process, and the failure surfaced in whichever spec ran next.
    const crashed = await request.post(`${PM_STUB_URL}/v1/chat/completions`, {
      // Says the throw is the point of this request, so `stub-crash-reporter` does not fail every
      // green run over the one crash the suite makes deliberately (BP-581)
      headers: { [EXPECTED_CRASH_HEADER]: "1" },
      data: completion("Do something <<this is not JSON>>"),
    });
    expect(crashed.status()).toBe(500);
    // Loud on purpose: a guard that answered 200 would hide the throw from the spec that caused it.
    expect(await crashed.text()).toContain(CRASH_MARKER);

    // Alive. A dead stub refuses the connection rather than answering it.
    const health = await request.get(`${PM_STUB_URL}/health`);
    expect(health.status()).toBe(200);

    // And still serving completions, not merely accepting sockets.
    const after = await request.post(`${PM_STUB_URL}/v1/chat/completions`, {
      data: completion('Answer me <<{"say":"Still here."}>>'),
    });
    expect(after.status()).toBe(200);
    expect((await after.json()).choices[0].message.content).toBe("Still here.");

    // The control, and the thing the ticket is actually about: the next spec's product flow works.
    await signIn(page);
    await page.goto(PM_URL);
    await expect(chatBox(page)).toBeVisible();
    await chatBox(page).fill('What is on the board? <<{"say":"The board is quiet."}>>');
    await sendButton(page).click();
    await expect(reply(page)).toContainText("The board is quiet.");
  });
});
