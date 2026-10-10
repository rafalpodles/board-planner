import { test, expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  asOrganisation,
  bearer,
  hostOf,
  originOf,
  seedTwoOrganisations,
  signInOn,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function aMember(who: OrganisationFixture): Promise<string> {
  const sessionToken = `cps_member_${who.slug}_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await withDb(async (db) => {
    const { insertedId: member } = await db.collection("users").insertOne({
      organisation: who.organisation,
      username: "crew",
      fullName: `${who.slug} crew`,
      email: `crew@${who.slug}.example`,
      kind: "human",
      role: "member",
      createdAt: now,
    });
    await db.collection("sessions").insertOne({
      organisation: who.organisation,
      tokenHash: crypto.createHash("sha256").update(sessionToken).digest("hex"),
      user: member,
      expiresAt: later,
      absoluteExpiresAt: later,
      lastUsedAt: now,
      userAgent: "",
      ip: "",
      createdAt: now,
    });
  });
  return sessionToken;
}

const asSession = (who: OrganisationFixture, sessionToken = who.sessionToken) => ({
  ...asOrganisation(who),
  cookie: `__Host-bp_session=${sessionToken}`,
  origin: originOf(who),
});

const renamesIn = (who: OrganisationFixture) =>
  withDb((db) => db.collection("instanceauditlogs").find({ organisation: who.organisation, action: "organisation_renamed" }).toArray());

async function openSettings(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/settings/organisation`);
  await expect(page.getByTestId("organisation-page")).toBeVisible();
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

// BP-920: after Phase 2 nothing on screen said which organisation a person was in
test.describe("BP-920: the app names the organisation you are in", () => {
  test("each organisation sees its own name in the sidebar and on Settings → Organisation, with its own address and counts", async ({ browser }) => {
    for (const [who, name] of [[ACME, "Acme"], [GLOBEX, "Globex"]] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openSettings(page, who);

      await expect(page.getByTestId("sidebar-organisation")).toHaveText(name);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
      await expect(page.getByTestId("organisation-address")).toHaveText(hostOf(who));
      await expect(page.getByTestId("organisation-plan")).toHaveText("Free");
      await expect(page.getByTestId("organisation-members")).toHaveText("1");
      await expect(page.getByTestId("organisation-projects")).toHaveText("1");
      await expect(page.getByRole("heading", { name: "Licence" })).toBeVisible();
      await page.screenshot({ path: `e2e/.artifacts/bp920-settings-${who.slug}.png` });
      await context.close();
    }
  });

  test("an admin renames their organisation on screen, the sidebar follows at once, and the other organisation keeps its name", async ({ page, request }) => {
    await openSettings(page, ACME);

    await page.getByLabel("Name", { exact: true }).fill("Acme Rocket Works");
    const saved = page.waitForResponse((res) => res.url().endsWith("/api/organisation") && res.request().method() === "PUT");
    await page.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId("sidebar-organisation")).toHaveText("Acme Rocket Works");

    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Acme Rocket Works");

    const globex = await request.get(`${ORGANISATIONS_API}/api/organisation`, { headers: asSession(GLOBEX) });
    expect((await globex.json()).name).toBe("Globex");
    expect((await renamesIn(ACME)).map((row) => row.detail)).toEqual(["Acme → Acme Rocket Works"]);
    expect(await renamesIn(GLOBEX)).toEqual([]);
  });

  test("BP-1010: a name another organisation has, in any case, or a reserved word, is refused with the reason on screen, and nothing is renamed", async ({ page, request }) => {
    await openSettings(page, ACME);

    for (const name of ["GLOBEX", "login"]) {
      await page.getByLabel("Name", { exact: true }).fill(name);
      const saved = page.waitForResponse((res) => res.url().endsWith("/api/organisation") && res.request().method() === "PUT");
      await page.getByRole("button", { name: "Save" }).click();
      expect((await saved).status()).toBe(409);
      await expect(page.getByText("That name is not available. Try another.")).toBeVisible();
    }

    const acme = await request.get(`${ORGANISATIONS_API}/api/organisation`, { headers: asSession(ACME) });
    expect((await acme.json()).name).toBe("Acme");
    expect(await renamesIn(ACME)).toEqual([]);

    const recased = await request.put(`${ORGANISATIONS_API}/api/organisation`, { headers: asSession(ACME), data: { name: "ACME" } });
    expect(recased.status()).toBe(200);
  });

  test("a member reads the name and cannot change it, on screen or through the API", async ({ browser, request }) => {
    const sessionToken = await aMember(ACME);
    const context = await browser.newContext();
    await context.addCookies([{ name: "__Host-bp_session", value: sessionToken, domain: `${ACME.slug}.organisations.localhost`, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto(`${originOf(ACME)}/settings/organisation`);

    await expect(page.getByTestId("organisation-name")).toHaveText("Acme");
    await expect(page.getByTestId("sidebar-organisation")).toHaveText("Acme");
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("organisation-members")).toHaveCount(0);
    await context.close();

    const refused = await request.put(`${ORGANISATIONS_API}/api/organisation`, { headers: asSession(ACME, sessionToken), data: { name: "Crew's" } });
    expect(refused.status()).toBe(403);
    expect(await renamesIn(ACME)).toEqual([]);
  });

  test("an admin's machine credential is refused, and so is the other organisation's session on this host", async ({ request }) => {
    const machine = await request.put(`${ORGANISATIONS_API}/api/organisation`, { headers: { ...asOrganisation(ACME), ...bearer(ACME) }, data: { name: "Token's" } });
    expect(machine.status()).toBe(403);

    const crossed = await request.put(`${ORGANISATIONS_API}/api/organisation`, {
      headers: { ...asOrganisation(ACME), cookie: `__Host-bp_session=${GLOBEX.sessionToken}`, origin: originOf(ACME) },
      data: { name: "Globex's now" },
    });
    expect(crossed.status()).toBe(401);

    const acme = await request.get(`${ORGANISATIONS_API}/api/organisation`, { headers: asSession(ACME) });
    expect((await acme.json()).name).toBe("Acme");
    expect(await renamesIn(ACME)).toEqual([]);
  });

  test("at phone width the name sits in the drawer, truncated rather than wrapped", async ({ page }) => {
    await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation }, { $set: { name: "Acme Interplanetary Rocket and Propulsion Works Limited" } }));
    await page.setViewportSize({ width: 375, height: 812 });
    await openSettings(page, ACME);
    await page.screenshot({ path: "e2e/.artifacts/bp920-settings-phone.png" });

    await page.getByRole("button", { name: "Open navigation" }).click();
    const line = page.getByTestId("sidebar-organisation");
    await expect(line).toBeInViewport({ ratio: 1 });
    await page.waitForFunction(() => document.querySelector("aside")?.getBoundingClientRect().left === 0);
    await expect(line).toHaveAttribute("title", "Acme Interplanetary Rocket and Propulsion Works Limited");
    const box = await line.boundingBox();
    expect(box!.height).toBeLessThan(24);
    await page.screenshot({ path: "e2e/.artifacts/bp920-sidebar-phone.png" });
  });
});
