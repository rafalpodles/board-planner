import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MAIL_SERVER, SMTP_STUB_CONTROL_URL } from "../playwright.config";
import { ADMIN_ID, ADMIN_USERNAME, E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-469, last item. "Send a test message" is the only reason `/settings/email` exists — everywhere
 * else a delivery failure is swallowed, which is why a misconfigured deployment looks exactly like
 * a working one. Until this file nobody had ever pressed it: the button appears in two specs and in
 * both of them the assertion is `toBeDisabled()`.
 *
 * So none of the three answers the screen can give had been seen. `handleTest` maps a 502 onto "The
 * mail server refused it" and everything else onto "Nothing was sent", and that distinction is the
 * point — telling an admin the server refused a message it was never handed sends them to the wrong
 * place to look. A unit test pins the mapping (`page.test.tsx`); what runs here is the composition,
 * from a click to a message a mail server has.
 *
 * BP-465 is what makes that possible: `e2e/smtp-stub.mjs` is a real SMTP peer, so the message goes
 * out through nodemailer, STARTTLS, AUTH and the production template. Its refusal is real too — the
 * 550 the screen quotes back is a sentence the server said, not a status a route interceptor made
 * up. The one answer that cannot be arranged that way is a request that never reached the instance,
 * and that one is driven by cutting the connection.
 *
 * Each test owns its own recipient address, and every assertion filters the mail server's log by
 * it. The run's other mail is fire-and-forget and can still be in flight when this file starts, so
 * a count of what has arrived, or a refusal aimed at whatever comes next, would be measuring the
 * neighbours.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/**
 * The address the test message goes to. Written to the database rather than typed into the profile
 * form: that round trip is `instance-settings.spec.ts`'s subject, and it costs a password.
 */
async function giveTheAdminTheAddress(address: string) {
  const handle = await db();
  const result = await handle
    .collection("users")
    .updateOne({ _id: ADMIN_ID }, { $set: { email: address } });
  // Asserted, because the button is disabled without an address: a screen that never offered it
  // would otherwise read as a screen whose delivery failed
  expect(result.matchedCount, "no admin account to give an address to").toBe(1);
}

interface StubMessage {
  from: string;
  to: string[];
  data: string;
}

async function mailFor(address: string): Promise<StubMessage[]> {
  const response = await fetch(`${SMTP_STUB_CONTROL_URL}/messages`);
  const arrived: StubMessage[] = await response.json();
  return arrived.filter((message) => message.to.includes(address));
}

async function refuseMailFor(address: string) {
  await fetch(`${SMTP_STUB_CONTROL_URL}/refuse?to=${encodeURIComponent(address)}`);
}

async function stopRefusing() {
  await fetch(`${SMTP_STUB_CONTROL_URL}/refuse`);
}

async function openTheMailScreen(page: Page) {
  await signIn(page);
  await page.goto("/settings/email");
  // A positive first: everything below this file asserts is about a screen that has read its
  // settings, and the spinner satisfies "no error is shown" just as well as success does
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible();
}

const sendButton = (page: Page) => page.getByRole("button", { name: /Send a test message|Sending/ });

test.beforeEach(seed);

test.afterEach(async () => {
  await stopRefusing();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("the screen reports the mail server it was given, and offers to use it", async ({ page }) => {
  await giveTheAdminTheAddress("reports-the-server@e2e.invalid");
  await openTheMailScreen(page);

  // The three rows come off one object the dev server was configured from, so a screen printing
  // the wrong field — or `host` where `host:port` belongs — has nowhere to hide
  await expect(page.getByText(`${MAIL_SERVER.host}:${MAIL_SERVER.port}`)).toBeVisible();
  await expect(page.getByText(MAIL_SERVER.user, { exact: true })).toBeVisible();
  await expect(page.getByText(MAIL_SERVER.from, { exact: true })).toBeVisible();
  await expect(page.getByText("No mail server is configured.")).toHaveCount(0);

  await expect(sendButton(page)).toBeEnabled();
  await expect(
    page.getByText("It goes to reports-the-server@e2e.invalid, the address on your profile.")
  ).toBeVisible();
});

// The whole question the screen exists to answer: does mail leave this deployment
test("a test message reaches the mail server, and the screen names where it went", async ({
  page,
}) => {
  const ADDRESS = "delivery-works@e2e.invalid";
  await giveTheAdminTheAddress(ADDRESS);
  await openTheMailScreen(page);

  await sendButton(page).click();

  await expect(page.getByText(`Accepted for delivery to ${ADDRESS}`)).toBeVisible({
    // The mail path — nodemailer, the template, the transport — is compiled by the dev server on
    // first use, and on a cold run that is most of this wait
    timeout: 60_000,
  });
  await expect(page.getByText(/check the spam folder/)).toBeVisible();

  const arrived = await mailFor(ADDRESS);
  expect(arrived).toHaveLength(1);
  // What the production template wrote, not what the screen echoed: the heading and the account
  // that asked for it are in the body, and the envelope sender is the configured From
  expect(arrived[0].data).toContain("Your mail server accepted this message");
  expect(arrived[0].data).toContain(ADMIN_USERNAME);
  expect(arrived[0].from).toBe(MAIL_SERVER.from.replace(/^.*<|>$/g, ""));
});

test("when the mail server refuses, the screen says so and repeats what it said", async ({
  page,
}) => {
  const ADDRESS = "server-says-no@e2e.invalid";
  await giveTheAdminTheAddress(ADDRESS);
  await refuseMailFor(ADDRESS);
  await openTheMailScreen(page);

  await sendButton(page).click();

  const refusal = page.getByRole("alert");
  await expect(refusal.getByText("The mail server refused it")).toBeVisible({ timeout: 60_000 });
  // The sentence the server said, which is the only thing that tells an admin where to look. A
  // screen that reported its own wording would pass the heading above and fail here.
  await expect(refusal.getByText(/550/)).toBeVisible();

  // And nothing was delivered behind the refusal
  expect(await mailFor(ADDRESS)).toHaveLength(0);
});

// The other half of that distinction. Nothing was handed to a mail server, so blaming one sends
// the admin to read logs that have nothing in them.
test("a request that never arrives does not blame the mail server", async ({ page }) => {
  const ADDRESS = "never-left-the-browser@e2e.invalid";
  await giveTheAdminTheAddress(ADDRESS);
  await openTheMailScreen(page);

  // Only the send. The screen has already read its settings through this same path, and a GET
  // aborted alongside it would put the page on its failed-to-read branch instead.
  await page.route("**/api/admin/email", (route) =>
    route.request().method() === "POST" ? route.abort("connectionfailed") : route.fallback()
  );

  await sendButton(page).click();

  const failure = page.getByRole("alert");
  await expect(failure.getByText("Nothing was sent")).toBeVisible();
  await expect(failure.getByText("The mail server refused it")).toHaveCount(0);
  expect(await mailFor(ADDRESS)).toHaveLength(0);
});

// The third condition on the button, and the one a configured instance still meets. Until now it
// was only ever asserted on a screen with no mail server either, where the disabled button proves
// nothing about which of the two reasons disabled it.
test("with a mail server but no address of their own, there is nowhere to send", async ({
  page,
}) => {
  // The seed leaves every account's address empty, so this is the state as it comes
  await openTheMailScreen(page);

  await expect(page.getByText(`${MAIL_SERVER.host}:${MAIL_SERVER.port}`)).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await expect(page.getByText(/Add an address to/)).toBeVisible();
  await expect(page.getByRole("link", { name: "your profile" })).toHaveAttribute(
    "href",
    "/settings/profile"
  );
});
