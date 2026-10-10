import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { bodyOf, mailFor, refuseMailFor, stopRefusing } from "./mailbox";
import { ACME, GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, asOrganisation, bearer, originOf, seedTwoOrganisations } from "./organisations";
import { withDb } from "./platform-sign-in";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-674. An organisation whose plan ended and where nobody has signed in for a whole period is told it will
 * be deleted, given 30 days and a reminder a week before the end (BP-999), then suspended and deleted. The sweep runs here with the clock moved forward
 * (`POST /api/e2e/dead-organisations`), which is the only way to see two months go by.
 */

const sweep = async (request: APIRequestContext, body: { daysFromNow?: number; days?: number } = {}) => {
  const response = await request.post(`${ORGANISATIONS_API}/api/e2e/dead-organisations`, { data: body });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<{ looked: number; noticed: number; reminded: number; cleared: number; suspended: number; deleted: number }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A header line may be folded anywhere there is a space
const subjectLine = (subject: string) => new RegExp(`^Subject: ${subject.split(" ").join("\\s+")}\\s*$`, "m");
const deletionDateOf = (noticeAt: Date) =>
  new Date(noticeAt.getTime() + 30 * DAY_MS).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const organisationRow = (who: { organisation: unknown }) => withDb((db) => db.collection("organisations").findOne({ _id: who.organisation } as never));

// ACME's plan ended 90 days ago; GLOBEX holds Pro
async function endAcmesPlanAndGiveGlobexPro(request: APIRequestContext) {
  await withDb((db) =>
    db.collection("organisations").updateOne(
      { _id: ACME.organisation as never },
      { $set: { licenceKey: e2eLicence({ customer: "acme", organisation: ACME.organisation.toHexString(), expiresInDays: -90 }) } }
    )
  );
  const path = `/api/platform/organisations/${GLOBEX.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: "globex", organisation: GLOBEX.organisation.toHexString() }) }));
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const stored = await request.post(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data: body });
  expect(stored.status(), await stored.text()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await endAcmesPlanAndGiveGlobexPro(request);
});

test("an organisation with no plan and no sign-in is told first, reminded a week before the end, then suspended after 30 days, then deleted; one with a plan is never touched", async ({ request }) => {
  // The mail stub keeps everything the run has sent, so every assertion is against what it held before this one
  const mailBefore = (await mailFor("boss@acme.example")).length;
  const globexBefore = (await mailFor("boss@globex.example")).length;

  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 1, reminded: 0, suspended: 0, deleted: 0 });
  await expect.poll(async () => (await mailFor("boss@acme.example")).length).toBe(mailBefore + 1);
  const noticeAt = (await organisationRow(ACME))?.deadNoticeAt as Date;
  expect(noticeAt).toBeInstanceOf(Date);
  const notice = bodyOf((await mailFor("boss@acme.example")).at(-1)!);
  expect(notice).toMatch(/will be deleted/);
  expect(notice).toMatch(subjectLine(`Acme will be suspended and deleted on ${deletionDateOf(noticeAt)}`));
  expect(notice).toContain(`Signing in, or choosing a plan, before ${deletionDateOf(noticeAt)} cancels the deletion`);
  expect(notice).toContain(`${originOf(ACME)}/settings/export`);

  // Until a week before the end nothing more happens
  expect(await sweep(request, { daysFromNow: 83 })).toMatchObject({ noticed: 0, reminded: 0, suspended: 0, deleted: 0 });
  expect((await organisationRow(ACME))?.deadReminderAt ?? null).toBeNull();
  expect(await mailFor("boss@acme.example")).toHaveLength(mailBefore + 1);

  expect(await sweep(request, { daysFromNow: 84 })).toMatchObject({ noticed: 0, reminded: 1, suspended: 0, deleted: 0 });
  await expect.poll(async () => (await mailFor("boss@acme.example")).length).toBe(mailBefore + 2);
  const reminder = bodyOf((await mailFor("boss@acme.example")).at(-1)!);
  expect(reminder).toMatch(subjectLine(`Reminder: Acme will be suspended and deleted on ${deletionDateOf(noticeAt)}`));
  expect(reminder).toContain(`${originOf(ACME)}/settings/export`);
  expect((await organisationRow(ACME))?.deadReminderAt).toBeInstanceOf(Date);

  // Once is all: the sweeps after it, to the last day of the period, send nothing
  expect(await sweep(request, { daysFromNow: 85 })).toMatchObject({ reminded: 0, suspended: 0 });
  expect(await sweep(request, { daysFromNow: 90 })).toMatchObject({ reminded: 0, suspended: 0 });
  await new Promise((settle) => setTimeout(settle, 1000));
  expect(await mailFor("boss@acme.example")).toHaveLength(mailBefore + 2);
  expect((await organisationRow(ACME))?.suspendedAt ?? null).toBeNull();

  expect(await sweep(request, { daysFromNow: 91 })).toMatchObject({ suspended: 1, deleted: 0 });
  expect((await organisationRow(ACME))?.suspendedReason).toMatch(/dead organisation/);
  const refused = await request.get(`${ORGANISATIONS_API}/api/projects`, { headers: { ...asOrganisation(ACME), ...bearer(ACME) } });
  expect(refused.status()).toBe(503);

  // Work admitted before the suspension may still be writing, so a delete waits ten minutes after it; the suite does not
  expect(await sweep(request, { daysFromNow: 92 })).toMatchObject({ deleted: 0 });
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation as never }, { $set: { suspendedAt: new Date(Date.now() - 11 * 60 * 1000) } }));
  expect(await sweep(request, { daysFromNow: 92 })).toMatchObject({ deleted: 1 });
  expect((await organisationRow(ACME))?.deletedAt).toBeInstanceOf(Date);
  expect(await withDb((db) => db.collection("users").countDocuments({ organisation: ACME.organisation as never }))).toBe(0);

  // The organisation with a plan, and its people, are as they were
  expect((await organisationRow(GLOBEX))?.deadNoticeAt ?? null).toBeNull();
  expect(await withDb((db) => db.collection("users").countDocuments({ organisation: GLOBEX.organisation as never }))).toBeGreaterThan(0);
  expect(await mailFor("boss@globex.example")).toHaveLength(globexBefore);
  const audit = await withDb((db) => db.collection("platformauditlogs").find({ keyId: "dead-organisation-sweep" }).toArray());
  expect(audit.map((a) => a.action)).toEqual(["organisation_dead_noticed", "organisation_dead_reminded", "organisation_suspended", "organisation_delete_started", "organisation_deleted"]);
});

test("somebody signing in before the deletion calls it off, and a suspension the sweep made is lifted", async ({ request }) => {
  await sweep(request, { daysFromNow: 61 });
  await sweep(request, { daysFromNow: 84 });
  await sweep(request, { daysFromNow: 91 });
  expect((await organisationRow(ACME))?.suspendedAt).toBeInstanceOf(Date);

  // A sign-in on the day the clock now says, 95 days on
  const signedIn = new Date(Date.now() + 95 * DAY_MS);
  await withDb((db) => db.collection("users").updateOne({ _id: ACME.adminId as never }, { $set: { lastSignInAt: signedIn } }));

  expect(await sweep(request, { daysFromNow: 96 })).toMatchObject({ cleared: 1, deleted: 0 });
  const row = await organisationRow(ACME);
  expect(row?.deadNoticeAt ?? null).toBeNull();
  expect(row?.deadReminderAt ?? null).toBeNull();
  expect(row?.suspendedAt ?? null).toBeNull();
  expect(row?.deletedAt ?? null).toBeNull();
});

test("a sign-in after the reminder calls off notice and reminder both, and the next quiet period gets a notice and a reminder of its own", async ({ request }) => {
  await sweep(request, { daysFromNow: 61 });
  expect(await sweep(request, { daysFromNow: 84 })).toMatchObject({ reminded: 1 });
  expect((await organisationRow(ACME))?.deadReminderAt).toBeInstanceOf(Date);

  await withDb((db) => db.collection("users").updateOne({ _id: ACME.adminId as never }, { $set: { lastSignInAt: new Date(Date.now() + 86 * DAY_MS) } }));
  expect(await sweep(request, { daysFromNow: 87 })).toMatchObject({ cleared: 1, reminded: 0 });
  let row = await organisationRow(ACME);
  expect(row?.deadNoticeAt ?? null).toBeNull();
  expect(row?.deadReminderAt ?? null).toBeNull();

  // Nothing at what was the end of the first period
  expect(await sweep(request, { daysFromNow: 92 })).toMatchObject({ noticed: 0, reminded: 0, suspended: 0, deleted: 0 });

  // Sixty quiet days after that sign-in it starts again from the beginning
  expect(await sweep(request, { daysFromNow: 147 })).toMatchObject({ noticed: 1, reminded: 0 });
  row = await organisationRow(ACME);
  expect(row?.deadNoticeAt).toBeInstanceOf(Date);
  expect(row?.deadReminderAt ?? null).toBeNull();
  expect(await sweep(request, { daysFromNow: 170 })).toMatchObject({ reminded: 1, suspended: 0 });
});

test("a reminder the mail server refused is sent at the next sweep, and its loss does not hold the suspension back", async ({ request }) => {
  await sweep(request, { daysFromNow: 61 });
  const mailBefore = (await mailFor("boss@acme.example")).length;

  await refuseMailFor("boss@acme.example");
  try {
    expect(await sweep(request, { daysFromNow: 84 })).toMatchObject({ reminded: 0 });
  } finally {
    await stopRefusing();
  }
  expect((await organisationRow(ACME))?.deadReminderAt ?? null).toBeNull();

  expect(await sweep(request, { daysFromNow: 85 })).toMatchObject({ reminded: 1 });
  await expect.poll(async () => (await mailFor("boss@acme.example")).length).toBe(mailBefore + 1);
  expect(bodyOf((await mailFor("boss@acme.example")).at(-1)!)).toMatch(/^Subject: Reminder:/m);

  // The notice named the date; a reminder that never arrives does not move it
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation as never }, { $set: { deadReminderAt: null } }));
  expect(await sweep(request, { daysFromNow: 91 })).toMatchObject({ reminded: 0, suspended: 1 });
});

test("nothing happens when it is switched off, and nothing is deleted that nobody could be told about", async ({ request }) => {
  expect(await sweep(request, { daysFromNow: 61, days: 0 })).toMatchObject({ looked: 0, noticed: 0 });
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();

  await withDb((db) => db.collection("users").updateOne({ _id: ACME.adminId as never }, { $set: { email: "" } }));
  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 0 });
  // Inside the window a notice that went out would now be due its suspension: one that did not must not be
  expect(await sweep(request, { daysFromNow: 84 })).toMatchObject({ reminded: 0 });
  expect(await sweep(request, { daysFromNow: 91 })).toMatchObject({ suspended: 0, deleted: 0 });
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();
  expect((await organisationRow(ACME))?.deletedAt ?? null).toBeNull();
});

test("an operator's own suspension is not the sweep's to build on", async ({ request }) => {
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation as never }, { $set: { suspendedAt: new Date(), suspendedReason: "chargeback" } }));

  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 0 });
  expect(await sweep(request, { daysFromNow: 90 })).toMatchObject({ suspended: 0, deleted: 0 });
  expect((await organisationRow(ACME))?.suspendedReason).toBe("chargeback");
});

test("use through a token counts as use, however long ago anybody signed in", async ({ request }) => {
  await withDb((db) =>
    db.collection("apitokens").updateMany({ organisation: ACME.organisation as never }, { $set: { lastUsedAt: new Date(Date.now() + 70 * 24 * 60 * 60 * 1000) } })
  );

  expect(await sweep(request, { daysFromNow: 75 })).toMatchObject({ noticed: 0, suspended: 0, deleted: 0 });
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();
});

// BP-982: deleting an organisation is not undone, so every kind of use the sweep reads has to be shown to count
const FUTURE_USE = () => new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
for (const [what, collection, field] of [
  ["a browser session", "sessions", "lastUsedAt"],
  ["a machine", "workers", "lastSeenAt"],
  ["a connected app", "oauthtokens", "createdAt"],
] as const) {
  test(`use through ${what} counts as use, however long ago anybody signed in`, async ({ request }) => {
    const { modifiedCount } = await withDb((db) => db.collection(collection).updateMany({ organisation: ACME.organisation as never }, { $set: { [field]: FUTURE_USE() } }));
    expect(modifiedCount).toBeGreaterThan(0);

    expect(await sweep(request, { daysFromNow: 75 })).toMatchObject({ noticed: 0, suspended: 0, deleted: 0 });
    expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();

    // The use is what held it off, and the sweep does reach this organisation: sixty days after that use it is told
    await sweep(request, { daysFromNow: 131 });
    expect((await organisationRow(ACME))?.deadNoticeAt).toBeInstanceOf(Date);
  });
}

test("a person who has just joined counts as use, however long ago anybody signed in", async ({ request }) => {
  await withDb((db) =>
    db.collection("users").insertOne({
      organisation: ACME.organisation,
      username: "newcomer",
      fullName: "New Comer",
      email: "newcomer@acme.example",
      kind: "human",
      role: "member",
      deactivatedAt: null,
      createdAt: FUTURE_USE(),
    })
  );

  expect(await sweep(request, { daysFromNow: 75 })).toMatchObject({ noticed: 0, suspended: 0, deleted: 0 });
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();

  await sweep(request, { daysFromNow: 131 });
  expect((await organisationRow(ACME))?.deadNoticeAt).toBeInstanceOf(Date);
});

test("the default organisation is never noticed, suspended or deleted, however old and quiet it is", async ({ request }) => {
  await withDb(async (db) => {
    await db.collection("organisations").insertOne({ _id: DEFAULT_ORGANISATION_ID as never, name: "Default", slug: "default", deletedAt: null });
    await db.collection("users").insertOne({
      organisation: DEFAULT_ORGANISATION_ID,
      username: "root",
      fullName: "Root",
      email: "root@default.example",
      kind: "human",
      role: "admin",
      deactivatedAt: null,
      lastSignInAt: new Date(0),
      createdAt: new Date(0),
    });
  });

  for (const daysFromNow of [61, 84, 91, 92]) await sweep(request, { daysFromNow });

  const row = await withDb((db) => db.collection("organisations").findOne({ _id: DEFAULT_ORGANISATION_ID as never }));
  expect(row).toMatchObject({ name: "Default" });
  expect(row?.deadNoticeAt ?? null).toBeNull();
  expect(row?.suspendedAt ?? null).toBeNull();
  expect(row?.deletingAt ?? null).toBeNull();
  expect(await mailFor("root@default.example")).toHaveLength(0);
});

test("a stored key that does not verify is a plan nobody can read, not no plan", async ({ request }) => {
  // An organisation that is old by its id, with one old person and a key that does not verify
  const old = new mongoose.Types.ObjectId(`${Math.floor(Date.UTC(2025, 0, 1) / 1000).toString(16)}0000000000000000`);
  await withDb(async (db) => {
    await db.collection("organisations").insertOne({ _id: old as never, name: "Old Co", slug: "old-co", licenceKey: "not-a-key.at-all" });
    await db.collection("users").insertOne({
      organisation: old as never,
      username: "oldboss",
      fullName: "Old Boss",
      email: "boss@old-co.example",
      kind: "human",
      role: "admin",
      createdAt: new Date(Date.UTC(2025, 0, 1)),
    });
  });

  const oldBefore = (await mailFor("boss@old-co.example")).length;
  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 1 });
  expect((await organisationRow({ organisation: old }))?.deadNoticeAt ?? null).toBeNull();
  expect((await organisationRow(ACME))?.deadNoticeAt).toBeInstanceOf(Date);
  expect(await mailFor("boss@old-co.example")).toHaveLength(oldBefore);
});

test("a notice nothing followed is given again, and an operator's resume voids it", async ({ request }) => {
  await withDb((db) =>
    db.collection("organisations").updateOne(
      { _id: ACME.organisation as never },
      { $set: { deadNoticeAt: new Date(Date.now() - 30 * DAY_MS), deadReminderAt: new Date(Date.now() - 7 * DAY_MS) } }
    )
  );
  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 1, suspended: 0, deleted: 0 });
  // The notice given again gets its own reminder
  expect((await organisationRow(ACME))?.deadReminderAt ?? null).toBeNull();
  expect(await sweep(request, { daysFromNow: 84 })).toMatchObject({ reminded: 1 });

  const path = `/api/platform/organisations/${ACME.organisation.toHexString()}/resume`;
  const resumed = await request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, ...signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body: new Uint8Array() }, E2E_PLATFORM_REQUEST_KEY) },
  });
  expect(resumed.status()).toBe(200);
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();
  expect((await organisationRow(ACME))?.deadReminderAt ?? null).toBeNull();
});

test("a process already sending the notice holds the others off, and a lease that has run out is taken over without the notice having gone out", async ({ request }) => {
  const mailBefore = (await mailFor("boss@acme.example")).length;
  const sendingNow = new Date(Date.now() + 61 * 24 * 60 * 60 * 1000);
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation as never }, { $set: { deadNoticeClaimedAt: sendingNow } }));
  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 0 });
  expect((await organisationRow(ACME))?.deadNoticeAt ?? null).toBeNull();
  expect(await mailFor("boss@acme.example")).toHaveLength(mailBefore);

  // The lease is only a lease: it is released once the mail is out, and a dead sender's runs out
  await withDb((db) => db.collection("organisations").updateOne({ _id: ACME.organisation as never }, { $set: { deadNoticeClaimedAt: new Date(sendingNow.getTime() - 11 * 60 * 1000) } }));
  expect(await sweep(request, { daysFromNow: 61 })).toMatchObject({ noticed: 1 });
  const row = await organisationRow(ACME);
  expect(row?.deadNoticeAt).toBeInstanceOf(Date);
  expect(row?.deadNoticeClaimedAt ?? null).toBeNull();
});
