import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_MONGODB_URI, WORKER_CREDENTIAL } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  asOrganisation,
  SHARED_KEY,
  originOf,
  seedTwoOrganisations,
  signInOn,
  signInWithToken,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-989. A Free cloud organisation connects one machine for workers and agents; Pro and the trial connect
 * any number. ACME is Free, GLOBEX is made Pro where a spec needs the control. Each starts with its own
 * administrator's one machine, `<slug>-machine`, which is enabled and owned.
 */

const REMOTE = (who: OrganisationFixture) => `git@github.com:${who.slug}/rockets.git`;
const MEMBER_SESSION = (who: OrganisationFixture) => `cps_e2e989${who.slug}deadbeefdeadbeefdeadbeef`;
const SECOND = (who: OrganisationFixture) => new mongoose.Types.ObjectId(`e2e0000000000000000${who.slug === "acme" ? "ac" : "ab"}989`);

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function makePro(
  request: APIRequestContext,
  who: OrganisationFixture,
  licence: Parameters<typeof e2eLicence>[0] = {}
) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(
    JSON.stringify({
      licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString(), ...licence }),
    })
  );
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const response = await request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers },
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** A member who owns no machine, so the owner's own re-connection is not what lets them through */
async function addMember(who: OrganisationFixture): Promise<mongoose.Types.ObjectId> {
  return withDb(async (db) => {
    const now = new Date();
    const { insertedId } = await db.collection("users").insertOne({
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
      tokenHash: crypto.createHash("sha256").update(MEMBER_SESSION(who)).digest("hex"),
      user: insertedId,
      expiresAt: new Date(now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      lastUsedAt: now,
      userAgent: "",
      ip: "",
      createdAt: now,
    });
    return insertedId;
  });
}

async function boardWithRepository(who: OrganisationFixture) {
  await withDb((db) =>
    db.collection("projects").updateOne(
      { _id: who.projectId },
      { $set: { "worker.enabled": true, repositoryUrl: `https://github.com/${who.slug}/rockets`, githubRepo: "" } }
    )
  );
}

/** The board runs machines, and both machines report a checkout of its repository, each on its own host */
async function twoMachinesOnTheBoard(who: OrganisationFixture, secondOwner?: mongoose.Types.ObjectId) {
  await boardWithRepository(who);
  await withDb(async (db) => {
    const first = await db.collection("workers").findOne({ _id: who.workerId });
    const connectedAt = new Date(Date.now() - 86_400_000);
    await db.collection("workers").updateOne(
      { _id: who.workerId },
      { $set: { createdAt: connectedAt, repos: [{ remote: REMOTE(who), path: "/w/rockets" }], host: `${who.slug}-host-1` } }
    );
    const { _id: _ignored, ...rest } = first!;
    await db.collection("workers").insertOne({
      ...rest,
      _id: SECOND(who),
      name: `${who.slug}-second`,
      host: `${who.slug}-host-2`,
      credentialHash: bcrypt.hashSync(WORKER_CREDENTIAL, 4),
      repos: [{ remote: REMOTE(who), path: "/w/rockets" }],
      enabled: true,
      ...(secondOwner ? { owner: secondOwner } : {}),
      createdAt: new Date(),
    });
  });
}

const machineHeaders = (who: OrganisationFixture, workerId: mongoose.Types.ObjectId) => ({
  ...asOrganisation(who),
  authorization: `Bearer ${WORKER_CREDENTIAL}`,
  "x-worker-id": String(workerId),
  "x-cp-protocol": "1",
});

async function assignments(request: APIRequestContext, who: OrganisationFixture, workerId: mongoose.Types.ObjectId) {
  const response = await request.post(`${ORGANISATIONS_API}/api/workers/${workerId}/heartbeat`, {
    headers: machineHeaders(who, workerId),
    data: { repos: [{ remote: REMOTE(who), path: "/w/rockets" }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { assignments: unknown[] }).assignments;
}

const claim = (request: APIRequestContext, who: OrganisationFixture, workerId: mongoose.Types.ObjectId) =>
  request.post(`${ORGANISATIONS_API}/api/projects/${who.projectId}/tasks/claim`, {
    headers: machineHeaders(who, workerId),
    data: { runId: `run-${workerId}` },
  });

async function startDeviceEnrolment(request: APIRequestContext, who: OrganisationFixture, name: string, host: string) {
  const response = await request.post(`${ORGANISATIONS_API}/api/workers/enrolment/device`, {
    headers: { ...asOrganisation(who), "x-cp-protocol": "1", "content-type": "application/json" },
    data: { name, host },
  });
  expect(response.status(), await response.text()).toBe(201);
  return new URL(((await response.json()) as { verificationUrl: string }).verificationUrl).pathname;
}

async function mintFromMachinesPage(page: Page, who: OrganisationFixture) {
  await page.goto(`${originOf(who)}/settings/machines`);
  await page.getByRole("button", { name: "Connect a machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a machine" });
  const [minted] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/workers/enrolment") && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Mint token" }).click(),
  ]);
  return { dialog, status: minted.status() };
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await request.post(`${ORGANISATIONS_API}/api/e2e/licence`, { data: {} }).catch(() => {});
});

test("on Free, a member connecting a second machine is told the limit where the token is minted, and gets no token", async ({ page, request }) => {
  await addMember(ACME);
  await addMember(GLOBEX);
  await makePro(request, GLOBEX);

  await signInWithToken(page.context(), ACME, MEMBER_SESSION(ACME));
  const free = await mintFromMachinesPage(page, ACME);
  expect(free.status).toBe(402);
  const refusal = free.dialog.getByTestId("machine-limit");
  await expect(refusal).toContainText("which connects one machine for workers and agents, and one is already connected");
  await expect(refusal).toContainText("Ask an admin to upgrade to Pro.");
  await expect(free.dialog.getByText("Copy this token now")).toHaveCount(0);
  expect(await withDb((db) => db.collection("enrolmenttokens").countDocuments({ organisation: ACME.organisation }))).toBe(0);

  await signInWithToken(page.context(), GLOBEX, MEMBER_SESSION(GLOBEX));
  const pro = await mintFromMachinesPage(page, GLOBEX);
  expect(pro.status).toBe(201);
  await expect(pro.dialog.getByText("Copy this token now", { exact: false })).toBeVisible();
  await expect(pro.dialog.getByTestId("machine-limit")).toHaveCount(0);
});

test("on Free, the menubar's confirmation page says so before the click, and connecting the same machine again is not refused", async ({ page, request }) => {
  await boardWithRepository(ACME);
  const second = await startDeviceEnrolment(request, ACME, "acme-laptop-2", "acme-laptop-2.local");
  await signInOn(page.context(), ACME);

  await page.goto(`${originOf(ACME)}${second}`);
  const notice = page.getByTestId("machine-limit");
  await expect(notice).toContainText("which connects one machine for workers and agents, and one is already connected");
  await expect(notice.getByRole("link", { name: "Upgrade" })).toHaveAttribute("href", "/settings/organisation");
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: "Connect it" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 800 });
  const box = await notice.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 800 });

  // A disabled button is a courtesy; the route refuses on its own, before it switches the board on
  await withDb((db) => db.collection("projects").updateOne({ _id: ACME.projectId }, { $set: { "worker.enabled": false } }));
  const approved = await page.evaluate(
    async ({ path, projectId }) => {
      const res = await fetch(`/api/workers/enrolment/device/${path.split("/").pop()}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      return { status: res.status, body: await res.json() };
    },
    { path: second, projectId: String(ACME.projectId) }
  );
  expect(approved.status).toBe(402);
  expect(approved.body).toMatchObject({ feature: "workers.multiple", plan: "free" });
  expect(await withDb((db) => db.collection("workers").countDocuments({ organisation: ACME.organisation, name: "acme-laptop-2" }))).toBe(0);
  expect((await withDb((db) => db.collection("projects").findOne({ _id: ACME.projectId })))!.worker.enabled).toBe(false);
  await withDb((db) => db.collection("projects").updateOne({ _id: ACME.projectId }, { $set: { "worker.enabled": true } }));

  const same = await withDb((db) => db.collection("workers").findOne({ _id: ACME.workerId }));
  const again = await startDeviceEnrolment(request, ACME, same!.name, same!.host);
  await page.goto(`${originOf(ACME)}${again}`);
  await expect(page.getByTestId("already-registered")).toBeVisible();
  await expect(page.getByTestId("machine-limit")).toHaveCount(0);
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: "Connect it" })).toBeEnabled();
});

test("on Free, the owner of the connected machine is told a token only reconnects it, and a new machine registering with it is refused and keeps it until an upgrade", async ({ page, request }) => {
  await signInOn(page.context(), ACME);
  const minted = await mintFromMachinesPage(page, ACME);
  expect(minted.status).toBe(201);
  await expect(minted.dialog.getByTestId("reconnect-only")).toContainText("this token can only connect that machine again");
  await expect(minted.dialog.getByTestId("reconnect-only").getByRole("link", { name: "Upgrade" })).toBeVisible();
  const token = (await minted.dialog.locator("code").first().innerText()).trim();

  const register = () =>
    request.post(`${ORGANISATIONS_API}/api/workers/register`, {
      headers: { ...asOrganisation(ACME), authorization: `Bearer ${token}`, "x-cp-protocol": "1", "content-type": "application/json" },
      data: { name: "acme-box", host: "acme-box.local", platform: "linux", version: "1.0.0" },
    });

  const refused = await register();
  expect(refused.status()).toBe(402);
  expect(await refused.json()).toMatchObject({ feature: "workers.multiple", plan: "free", limit: 1 });
  expect(await withDb((db) => db.collection("workers").countDocuments({ organisation: ACME.organisation, name: "acme-box" }))).toBe(0);
  expect(await withDb((db) => db.collection("enrolmenttokens").findOne({ organisation: ACME.organisation }))).toMatchObject({ usedAt: null });

  await makePro(request, ACME);
  expect((await register()).status()).toBe(200);
});

test("after Pro ends with two machines, the first connected claims, the other is kept, told why, and takes over when the first is switched off", async ({ page, request }) => {
  await twoMachinesOnTheBoard(ACME);

  expect(await assignments(request, ACME, ACME.workerId)).toHaveLength(1);
  // Its bindings stay, so a refused change a person answers still settles on that machine; only the claim stops
  expect(await assignments(request, ACME, SECOND(ACME))).toHaveLength(1);
  const held = await claim(request, ACME, SECOND(ACME));
  expect(held.status()).toBe(409);
  expect((await held.json()).error).toBe(
    "The Free plan runs one machine per organisation, and another one was connected first. Upgrade to Pro, or switch the other machine off in Settings → Workers, for this one to take work."
  );
  expect((await claim(request, ACME, ACME.workerId)).status()).toBe(204);

  await signInOn(page.context(), ACME);
  await page.goto(`${originOf(ACME)}/settings/machines`);
  const mine = (name: string) => page.getByTestId("my-machine").filter({ hasText: name });
  await expect(mine("acme-second").getByTestId("my-machine-state")).toHaveText("Waiting: the Free plan runs one machine");
  await expect(mine("acme-second").getByTestId("my-machine-held")).toContainText("another one was connected first");
  await expect(mine("acme-machine").getByTestId("my-machine-state")).not.toHaveText(/Waiting/);

  await page.goto(`${originOf(ACME)}/settings/workers`);
  const row = (name: string) => page.getByRole("row").filter({ hasText: name }).first();
  await expect(row("acme-second").getByTestId("worker-held")).toContainText("Waiting · Free plan");
  await expect(row("acme-second").getByTestId("worker-held").getByRole("link", { name: "Upgrade" })).toHaveAttribute("href", "/settings/organisation");
  await expect(row("acme-machine").getByTestId("worker-held")).toHaveCount(0);

  const [off] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/workers/${ACME.workerId}`) && r.request().method() === "PATCH"),
    row("acme-machine").getByRole("button", { name: "On", exact: true }).click(),
  ]);
  expect(off.status()).toBe(200);
  expect((await claim(request, ACME, SECOND(ACME))).status()).toBe(204);

  const reloaded = page.waitForResponse((r) => r.url().endsWith("/api/admin/workers") && r.request().method() === "GET");
  await page.reload();
  await reloaded;
  await expect(row("acme-machine").getByRole("button", { name: "Off", exact: true })).toBeVisible();
  await expect(row("acme-second")).toContainText("acme-host-2");
  await expect(row("acme-second").getByTestId("worker-held")).toHaveCount(0);
  const [on] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/workers/${ACME.workerId}`) && r.request().method() === "PATCH"),
    row("acme-machine").getByRole("button", { name: "Off", exact: true }).click(),
  ]);
  expect(on.status()).toBe(402);
  await expect(page.getByText("which connects one machine for workers and agents, and one is already connected", { exact: false }).last()).toBeVisible();
  expect(await withDb((db) => db.collection("workers").countDocuments({ organisation: ACME.organisation }))).toBe(2);
});

test("on Pro, every machine claims", async ({ request }) => {
  await makePro(request, GLOBEX);
  await twoMachinesOnTheBoard(GLOBEX);

  expect(await assignments(request, GLOBEX, GLOBEX.workerId)).toHaveLength(1);
  expect(await assignments(request, GLOBEX, SECOND(GLOBEX))).toHaveLength(1);
  expect((await claim(request, GLOBEX, SECOND(GLOBEX))).status()).toBe(204);
});

test("on the trial a second machine connects through the menubar's page, and when the trial ends the first connected keeps claiming", async ({ page, request }) => {
  test.setTimeout(180_000);
  await boardWithRepository(ACME);
  await withDb((db) =>
    db.collection("workers").updateOne(
      { _id: ACME.workerId },
      { $set: { createdAt: new Date(Date.now() - 86_400_000), host: "acme-host-1", repos: [{ remote: REMOTE(ACME), path: "/w/rockets" }] } }
    )
  );
  // Ends a minute from now: a trial ends on its day, with no grace, and a lapsed key cannot be pushed
  await makePro(request, ACME, { trial: true, expiresInDays: 60 / 86_400 });

  const started = await request.post(`${ORGANISATIONS_API}/api/workers/enrolment/device`, {
    headers: { ...asOrganisation(ACME), "x-cp-protocol": "1", "content-type": "application/json" },
    data: { name: "acme-laptop-2", host: "acme-laptop-2.local" },
  });
  expect(started.status(), await started.text()).toBe(201);
  const { deviceCode, verificationUrl } = await started.json();

  await signInOn(page.context(), ACME);
  await page.goto(`${originOf(ACME)}${new URL(verificationUrl).pathname}`);
  await expect(page.getByRole("heading", { name: "Connect this machine?" })).toBeVisible();
  await expect(page.getByTestId("machine-limit")).toHaveCount(0);
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Connect it" }).click();
  await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();

  // The machine's half, as the menubar app collects its credential
  const collected = await request.post(`${ORGANISATIONS_API}/api/workers/enrolment/device/token`, {
    headers: { ...asOrganisation(ACME), "content-type": "application/json" },
    data: { deviceCode },
  });
  expect(collected.status()).toBe(200);
  const { workerId, credential } = await collected.json();
  const laptop = {
    ...asOrganisation(ACME),
    authorization: `Bearer ${credential}`,
    "x-worker-id": workerId,
    "x-cp-protocol": "1",
  };
  const laptopAssignments = async () => {
    const response = await request.post(`${ORGANISATIONS_API}/api/workers/${workerId}/heartbeat`, {
      headers: laptop,
      data: { repos: [{ remote: REMOTE(ACME), path: "/w/rockets" }] },
    });
    expect(response.status()).toBe(200);
    return ((await response.json()) as { assignments: unknown[] }).assignments.length;
  };

  const laptopClaims = async () =>
    (
      await request.post(`${ORGANISATIONS_API}/api/projects/${ACME.projectId}/tasks/claim`, {
        headers: laptop,
        data: { runId: "run-laptop" },
      })
    ).status();

  expect(await laptopAssignments()).toBe(1);
  expect(await laptopClaims()).toBe(204);
  expect(await assignments(request, ACME, ACME.workerId)).toHaveLength(1);

  await expect.poll(laptopClaims, { timeout: 90_000, intervals: [3_000] }).toBe(409);
  expect((await claim(request, ACME, ACME.workerId)).status()).toBe(204);
  expect(await withDb((db) => db.collection("workers").countDocuments({ organisation: ACME.organisation, enabled: true }))).toBe(2);

  await page.goto(`${originOf(ACME)}/settings/machines`);
  await expect(page.getByTestId("my-machine").filter({ hasText: "acme-laptop-2" }).getByTestId("my-machine-state")).toHaveText(
    "Waiting: the Free plan runs one machine"
  );
});

test("a member whose machine the Free plan holds is told so on their task, and the board's Workers section says it too", async ({ page }) => {
  const crew = await addMember(ACME);
  await twoMachinesOnTheBoard(ACME, crew);
  const agentId = new mongoose.Types.ObjectId();
  await withDb(async (db) => {
    const now = new Date();
    await db.collection("grants").insertOne({
      organisation: ACME.organisation,
      subject: crew,
      relation: "member",
      objectType: "project",
      object: ACME.projectId,
      createdBy: ACME.adminId,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("agents").insertOne({
      _id: agentId,
      organisation: ACME.organisation,
      name: "Acme Runner",
      description: "",
      scope: "project",
      owner: null,
      project: ACME.projectId,
      builtIn: false,
      composition: { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [{ key: "push" }, { key: "pull-request" }] },
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("tasks").insertOne({
      organisation: ACME.organisation,
      project: ACME.projectId,
      taskNumber: 1,
      title: "Handed to the crew's machine",
      description: "",
      status: "todo",
      priority: "medium",
      category: "user-story",
      assignee: crew,
      assignedBy: crew,
      agent: agentId,
      checklist: [],
      linkedPRs: [],
      blockedBy: [],
      relations: [],
      watchers: [],
      sprint: null,
      customFieldValues: {},
      order: 0,
      createdBy: crew,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("projects").updateOne({ _id: ACME.projectId }, { $max: { taskCounter: 1 } });
  });

  await signInWithToken(page.context(), ACME, MEMBER_SESSION(ACME));
  const readiness = page.waitForResponse((r) => r.request().method() === "GET" && r.url().endsWith("/handover"));
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/tasks/1`);
  expect(await (await readiness).json()).toMatchObject({ machine: "held" });
  const notice = page.getByRole("complementary").getByTestId("handover-notice");
  await expect(notice).toHaveAttribute("data-reason", "machine-held");
  await expect(notice).toContainText(
    "Your machine is connected but not taking work: the Free plan runs one machine per organisation, and another one was connected first. An admin can upgrade to Pro to use it too."
  );

  await signInOn(page.context(), ACME);
  await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/settings?section=workers`);
  const offering = (name: string) => page.getByTestId("offering-machine").filter({ hasText: name });
  await expect(offering("acme-second").getByTestId("offering-machine-state")).toHaveText("waiting: the Free plan runs one machine");
  await expect(offering("acme-second").getByTestId("offering-machine-held")).toContainText("another one was connected first. Upgrade");
  await expect(offering("acme-machine").getByTestId("offering-machine-state")).toHaveText("live");
});
