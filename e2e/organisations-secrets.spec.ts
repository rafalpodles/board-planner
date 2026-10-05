import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, ORGANISATIONS_API, asOrganisation, originOf, seedTwoOrganisations, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const session = (who: OrganisationFixture) => ({
  ...asOrganisation(who),
  cookie: `__Host-bp_session=${who.sessionToken}`,
  origin: originOf(who),
  "content-type": "application/json",
});

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function channels(request: APIRequestContext, who: OrganisationFixture) {
  const response = await request.get(`${ORGANISATIONS_API}/api/projects/${who.projectId}/notifications`, { headers: session(who) });
  expect(response.status()).toBe(200);
  return (await response.json()) as { name: string; webhookUrlMasked: string }[];
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-898: each organisation's secrets are sealed under its own key", () => {
  test("a channel URL is stored under the organisation's key, and copied onto another organisation's board it reads as nothing", async ({ request }) => {
    const added = await request.post(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/notifications`, {
      headers: session(ACME),
      data: { type: "slack", name: "Acme releases", webhookUrl: "https://hooks.slack.com/services/T000/B111/acme98765" },
    });
    expect(added.status(), await added.text()).toBe(201);
    expect((await channels(request, ACME)).map((c) => c.webhookUrlMasked)).toEqual(["https://hooks.slack.com/••••8765"]);

    const sealed = await withDb(async (db) => {
      const row = await db.collection("projects").findOne({ _id: ACME.projectId });
      const value = row!.notificationChannels[0].webhookUrl as string;
      await db.collection("projects").updateOne(
        { _id: GLOBEX.projectId },
        { $push: { notificationChannels: { _id: new mongoose.Types.ObjectId(), type: "slack", name: "Lifted from Acme", webhookUrl: value, enabled: true, events: ["task_created"] } } } as never
      );
      return value;
    });
    expect(sealed).toMatch(/^enc:v3:/);

    const lifted = (await channels(request, GLOBEX)).find((c) => c.name === "Lifted from Acme");
    expect(lifted?.webhookUrlMasked).toBe("••••");
  });
});
