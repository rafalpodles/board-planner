import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL, ORGANISATIONS_RELAY_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, USERNAME, originOf, seedTwoOrganisations, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function script(body: Record<string, unknown>) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

async function whoAmI(page: Page, who: OrganisationFixture) {
  const res = await page.request.get(`${originOf(who)}/api/auth/me`);
  return res.ok() ? (await res.json()).username : null;
}

const confirm = (who: OrganisationFixture) =>
  withDb((db) => db.collection("users").updateOne({ _id: who.adminId }, { $set: { emailVerifiedAt: new Date() } }));

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-895: provider sign-in returns through the platform's relay to the organisation that began it", () => {
  test("a sign-in started on one organisation's host finishes signed in there, through the relay", async ({ page }) => {
    await confirm(GLOBEX);
    await script({ sub: `sub-${randomBytes(4).toString("hex")}`, email: `boss@${GLOBEX.slug}.example`, email_verified: true });
    const hops: string[] = [];
    page.on("request", (r) => r.isNavigationRequest() && hops.push(r.url()));

    await page.goto(`${originOf(GLOBEX)}/login`);
    await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

    await expect(page).toHaveURL(`${originOf(GLOBEX)}/projects`);
    expect(await whoAmI(page, GLOBEX)).toBe(USERNAME);
    expect(await whoAmI(page, ACME)).toBeNull();
    const relayed = hops.findIndex((u) => u.startsWith(`${ORGANISATIONS_RELAY_ORIGIN}/api/auth/oidc/oidc/relay?`));
    const called = hops.findIndex((u) => u.startsWith(`${originOf(GLOBEX)}/api/auth/oidc/oidc/callback?`));
    expect(relayed, hops.join("\n")).toBeGreaterThan(-1);
    expect(called, hops.join("\n")).toBeGreaterThan(relayed);
  });

  test("an identity linked in one organisation signs nobody into the other", async ({ page }) => {
    const subject = `sub-acme-${randomBytes(4).toString("hex")}`;
    await withDb((db) =>
      db.collection("identities").insertOne({
        organisation: ACME.organisation,
        user: ACME.adminId,
        provider: "oidc",
        issuer: OIDC_STUB_URL,
        subject,
        email: "",
        lastUsedAt: null,
        linkedAt: new Date(),
      })
    );
    await script({ sub: subject, email: `stranger-${randomBytes(3).toString("hex")}@nowhere.example`, email_verified: true });

    await page.goto(`${originOf(GLOBEX)}/login`);
    await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

    // Through the relay and Globex's own callback, which knows no such person: not ACME's account
    await expect(page).toHaveURL(`${originOf(GLOBEX)}/login?sso=no_account`);
    expect(await whoAmI(page, GLOBEX)).toBeNull();
  });
});
