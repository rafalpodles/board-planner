import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN, signInApi } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_KEY,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  SECOND_HELD_TASK_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-1040. A machine's row could be switched off and never removed, so every lost credential and
 * every re-enrolment left a `stale` row behind for good.
 *
 * Deleting is also what revokes the credential, so the three refusals matter as much as the
 * delete: a machine seen in the last five minutes, a machine that still holds a run, and anyone
 * who is not an administrator in a browser. Each is asserted against the same fixture the working
 * delete uses, so a silence caused by a mis-wired fixture cannot read as a refusal.
 */

const PROTOCOL = "1";
const MACHINE = { name: "e2e-lost-laptop", host: "lost-laptop.local", platform: "darwin", version: "0.0.0-e2e" };
const TEN_MINUTES = 10 * 60_000;

async function handle() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  return db;
}

async function workerCount(filter: Record<string, unknown>) {
  return (await handle()).collection("workers").countDocuments(filter);
}

async function backdate(filter: Record<string, unknown>) {
  await (await handle())
    .collection("workers")
    .updateOne(filter, { $set: { lastSeenAt: new Date(Date.now() - TEN_MINUTES) } });
}

function fleetRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name }).first();
}

async function openFleet(page: Page) {
  await signIn(page);
  await page.goto("/settings/workers");
  await expect(page.getByRole("heading", { name: "Worker fleet" })).toBeVisible();
}

async function enrolLostLaptop(request: APIRequestContext) {
  const minted = await request.post("/api/workers/enrolment", { headers: ADMIN_AUTH, data: {} });
  expect(minted.status(), await minted.text()).toBe(201);
  const { token } = await minted.json();
  const registered = await request.post("/api/workers/register", {
    headers: { Authorization: `Bearer ${token}`, "x-cp-protocol": PROTOCOL },
    data: MACHINE,
  });
  expect(registered.status(), await registered.text()).toBe(200);
  const body: { workerId: string; credential: string } = await registered.json();
  return { workerId: body.workerId, credential: body.credential };
}

test.beforeEach(async () => {
  await seed();
});

test("an admin deletes a machine that has gone quiet, and its credential stops working", async ({
  page,
  request,
}) => {
  const machine = await enrolLostLaptop(request);
  const asMachine = {
    Authorization: `Bearer ${machine.credential}`,
    "x-worker-id": machine.workerId,
    "x-cp-protocol": PROTOCOL,
  };
  expect((await request.get(`/api/workers/${machine.workerId}`, { headers: asMachine })).status()).toBe(200);

  await openFleet(page);
  const row = fleetRow(page, MACHINE.name);
  await expect(row.getByText(MACHINE.host)).toBeVisible();

  // The control: it has just reported in, so the same button on the same row is refused
  await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const tooSoon = await request.delete(`/api/workers/${machine.workerId}`, { headers: SAME_ORIGIN });
  expect(tooSoon.status(), await tooSoon.text()).toBe(409);
  expect(await workerCount({ name: MACHINE.name })).toBe(1);

  await backdate({ name: MACHINE.name });
  await page.reload();
  const quiet = fleetRow(page, MACHINE.name);
  await expect(quiet.getByText("stale")).toBeVisible();
  await quiet.getByRole("button", { name: "Delete" }).click();

  const dialog = page.getByRole("dialog", { name: `Delete ${MACHINE.name}?` });
  await expect(dialog).toContainText(MACHINE.host);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/workers/${machine.workerId}` && r.request().method() === "DELETE"
    ),
    dialog.getByRole("button", { name: "Delete" }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);

  await expect(fleetRow(page, WORKER_NAME).getByText(WORKER_NAME)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: MACHINE.name })).toHaveCount(0);
  expect(await workerCount({ name: MACHINE.name })).toBe(0);
  expect(await workerCount({ name: WORKER_NAME })).toBe(1);

  const after = await request.get(`/api/workers/${machine.workerId}`, { headers: asMachine });
  expect(after.status()).toBe(401);

  await page.goto("/settings/audit");
  const logged = page.getByRole("row").filter({ hasText: "Worker deleted" }).first();
  await expect(logged).toContainText(MACHINE.name);
});

test("a machine that still holds a run is not deleted, and the refusal names the tasks", async ({
  page,
  request,
}) => {
  await backdate({ _id: WORKER_ID });

  await openFleet(page);
  const row = fleetRow(page, WORKER_NAME);
  await expect(row.getByText("stale")).toBeVisible();
  await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();

  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const refused = await request.delete(`/api/workers/${WORKER_ID}`, { headers: SAME_ORIGIN });
  expect(refused.status()).toBe(409);
  const body = await refused.json();
  expect(body.taskKeys).toEqual(expect.arrayContaining([HELD_TASK_KEY, SECOND_HELD_TASK_KEY]));
  expect(await workerCount({ _id: WORKER_ID })).toBe(1);
});

test("only an administrator in a browser session can delete a machine", async ({ request }) => {
  await backdate({ _id: WORKER_ID });
  await (await handle()).collection("tasks").updateMany(
    { "execution.workerId": String(WORKER_ID) },
    { $set: { "execution.runId": "" } }
  );

  const asToken = await request.delete(`/api/workers/${WORKER_ID}`, { headers: ADMIN_AUTH });
  expect(asToken.status()).toBe(403);

  const asMachine = await request.delete(`/api/workers/${WORKER_ID}`, {
    headers: {
      ...SAME_ORIGIN,
      Authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(WORKER_ID),
      "x-cp-protocol": PROTOCOL,
    },
  });
  expect([401, 403]).toContain(asMachine.status());

  const asMemberToken = await request.delete(`/api/workers/${WORKER_ID}`, { headers: MEMBER_AUTH });
  expect(asMemberToken.status()).toBe(403);

  await signInApi(request, MEMBER_USERNAME, MEMBER_PASSWORD);
  const asMember = await request.delete(`/api/workers/${WORKER_ID}`, { headers: SAME_ORIGIN });
  expect(asMember.status()).toBe(403);

  expect(await workerCount({ _id: WORKER_ID })).toBe(1);

  // The control: with the run released and the machine quiet, the same worker goes for an admin
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const asAdmin = await request.delete(`/api/workers/${WORKER_ID}`, { headers: SAME_ORIGIN });
  expect(asAdmin.status(), await asAdmin.text()).toBe(200);
  expect(await workerCount({ _id: WORKER_ID })).toBe(0);
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
