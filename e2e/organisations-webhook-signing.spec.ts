import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "crypto";
import { RUN_ORGANISATIONS_SERVER, WEBHOOK_RECEIVER_URL, WEBHOOK_SECRET } from "../playwright.config";
import { ACME, GLOBEX, ORGANISATIONS_API, SHARED_KEY, asOrganisation, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

type Delivery = { url: string; body: string; headers: Record<string, string> };

const session = (who: OrganisationFixture) => ({
  ...asOrganisation(who),
  cookie: `__Host-bp_session=${who.sessionToken}`,
  origin: originOf(who),
  "content-type": "application/json",
});

const hmac = (secret: string, delivery: Delivery) =>
  crypto.createHmac("sha256", secret).update(`${delivery.headers["x-boardplanner-timestamp"]}.${delivery.body}`).digest("hex");

async function secretOf(request: APIRequestContext, who: OrganisationFixture): Promise<string> {
  const response = await request.get(`${ORGANISATIONS_API}/api/projects/${who.projectId}/webhooks/signing-secret`, { headers: session(who) });
  expect(response.status()).toBe(200);
  return (await response.json()).secret;
}

async function revealOnScreen(page: Page, who: OrganisationFixture): Promise<string> {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/projects/${SHARED_KEY}/settings?section=integrations`);
  const picker = page.getByRole("button", { name: "Add a connection" });
  const row = page.getByRole("button", { name: /^Webhooks/ });
  await expect(async () => {
    if (!(await row.first().isVisible())) {
      if (await picker.isVisible()) await picker.click();
      await page.getByRole("button", { name: /^Webhooks/ }).first().click();
    }
    await row.first().click();
    await expect(page.getByRole("button", { name: "Show signing secret" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "Show signing secret" }).click();
  const shown = page.getByTestId("webhook-signing-secret");
  await expect(shown).toHaveText(/^[0-9a-f]{64}$/);
  return (await shown.textContent())!;
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
  await fetch(`${WEBHOOK_RECEIVER_URL}/reset`, { method: "POST" });
});

test.describe("BP-669: each organisation signs its webhook deliveries with its own key", () => {
  test("the secret an owner reads on screen verifies their delivery, and neither the instance's nor another organisation's does", async ({ page, request }) => {
    const shown = await revealOnScreen(page, ACME);
    const globex = await secretOf(request, GLOBEX);
    expect(shown).not.toBe(globex);
    expect(shown).not.toBe(WEBHOOK_SECRET);

    const path = "/acme-hook";
    const added = await request.post(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/webhooks`, {
      headers: session(ACME),
      data: { url: `${WEBHOOK_RECEIVER_URL}${path}`, events: ["task_created"] },
    });
    expect(added.status(), await added.text()).toBe(201);
    const title = "Signed by Acme's own key";
    const created = await request.post(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/tasks`, { headers: session(ACME), data: { title } });
    expect(created.status(), await created.text()).toBe(201);

    let delivery: Delivery | undefined;
    await expect(async () => {
      const all: Delivery[] = await (await fetch(`${WEBHOOK_RECEIVER_URL}/deliveries`)).json();
      delivery = all.find((d) => d.url === path && d.body.includes(title));
      expect(delivery).toBeTruthy();
    }).toPass({ timeout: 15_000 });

    const signature = delivery!.headers["x-boardplanner-signature"];
    expect(signature).toBe(`t=${delivery!.headers["x-boardplanner-timestamp"]},v1=${hmac(shown, delivery!)}`);
    expect(signature).not.toContain(hmac(WEBHOOK_SECRET, delivery!));
    expect(signature).not.toContain(hmac(globex, delivery!));
  });

  test("an API token cannot read the signing secret, and a member of another organisation cannot reach the project", async ({ request }) => {
    const token = await request.get(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/webhooks/signing-secret`, {
      headers: { ...asOrganisation(ACME), authorization: `Bearer ${ACME.apiToken}` },
    });
    expect(token.status()).toBe(403);

    const foreign = await request.get(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/webhooks/signing-secret`, { headers: session(GLOBEX) });
    expect(foreign.status()).toBe(404);
  });
});
