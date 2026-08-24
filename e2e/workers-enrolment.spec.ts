import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  RUN_PHASE,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

/**
 * BP-392. What a machine costs a person: connecting one, stopping one, and reading what it did.
 *
 * `claim-ownership.spec.ts` covers what a machine may *take* — forty-three tests of it — and none
 * of that goes near a screen. `worker-enrolment-name.spec.ts` covers one lens on this flow, that a
 * hostile name never reaches a reader. This file is the rest: the handshake as the two people in
 * it perform it, the switches an admin uses to stop a machine, and the telemetry that comes back.
 * Nothing here restates a claim rule or a sanitising rule.
 *
 * The pairing every test is built on: **a credential is not proved by appearing in a list.** It is
 * proved by the same credential being taken on a real request before a switch is thrown, and
 * refused on the same request afterwards. A screen showing "Locked" over a machine that carries on
 * working is the failure this file exists to catch.
 *
 * Three notes on the fixture:
 *
 * - **The repository is written directly.** A project names one through Integrations, which has
 *   its own coverage; here it is a precondition — and the enrolment's refusal of a project that
 *   names none is itself asserted below.
 * - **`x-cp-protocol` is sent because the machine sends it.** The start route answers 409 to a
 *   mismatch, so leaving it off would test the refusal instead of the handshake.
 * - **This file needs its own database and port band.** It counts workers and reads a fleet-wide
 *   screen, so a second suite sharing the database does not make it wrong — it makes it fail.
 */

const PROTOCOL = "1";
const REPOSITORY = "https://github.com/rafalpodles/board-planner";
const CHECKOUT = "/Users/somebody/code/board-planner";
const MACHINE = { name: "e2e-thinkpad", host: "e2e-thinkpad.local" };

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function nameARepository(url = REPOSITORY) {
  await (await db())
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { repositoryUrl: url } });
}

async function workerRow(name: string) {
  return (await db()).collection("workers").findOne({ name });
}

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

/** The machine's half: it has nothing to authenticate with yet, which is the point of this route. */
async function machineAsksToEnrol(request: APIRequestContext, machine = MACHINE) {
  const response = await request.post("/api/workers/enrolment/device", {
    headers: { ...SAME_ORIGIN, "x-cp-protocol": PROTOCOL },
    data: machine,
  });
  expect(response.status(), await response.text()).toBe(201);
  const started = await response.json();
  // Port-agnostic: the server builds this from NEXT_PUBLIC_APP_URL and the suite moves ports
  return { ...started, path: new URL(started.verificationUrl).pathname };
}

/** The machine polling for its answer, exactly as the app on it does. */
async function machineCollects(request: APIRequestContext, deviceCode: string) {
  return request.post("/api/workers/enrolment/device/token", {
    headers: SAME_ORIGIN,
    data: { deviceCode },
  });
}

interface Machine {
  workerId: string;
  credential: string;
}

function asMachine(machine: Machine) {
  return {
    Authorization: `Bearer ${machine.credential}`,
    "x-worker-id": machine.workerId,
    "x-cp-protocol": PROTOCOL,
  };
}

/** A real request on the machine's own credential — the one thing that proves it is worth having. */
async function machineReadsItsWork(request: APIRequestContext, machine: Machine) {
  return request.get(`/api/workers/${machine.workerId}`, { headers: asMachine(machine) });
}

/** The machine reporting the checkouts it has. What the server matches a project's remote against. */
async function machineReportsCheckouts(
  request: APIRequestContext,
  machine: Machine,
  repos: { remote: string; path: string }[]
) {
  const response = await request.post(`/api/workers/${machine.workerId}/heartbeat`, {
    headers: asMachine(machine),
    data: { repos },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The whole handshake, ending with a machine that holds a working credential. */
async function enrolAMachine(
  page: Page,
  request: APIRequestContext,
  machine = MACHINE
): Promise<Machine> {
  const started = await machineAsksToEnrol(request, machine);
  await page.goto(started.path);
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Connect it" }).click();
  await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();

  const collected = await machineCollects(request, started.deviceCode);
  expect(collected.status(), await collected.text()).toBe(200);
  return collected.json();
}

/**
 * What the server chose for this machine, as against what the machine told the server.
 *
 * Scoped to these three fields deliberately. The payload also echoes `repos` back, which is the
 * machine's own report and is the one direction a path legitimately travels.
 */
function decidedByTheServer(view: {
  assignments: unknown;
  offers: unknown;
  catalogue: unknown;
}): string {
  return JSON.stringify({
    assignments: view.assignments,
    offers: view.offers,
    catalogue: view.catalogue,
  });
}

function fleetRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name }).first();
}

/** The policy chips are a row of their own beneath the machine's, so they are found by what they say. */
function policyRow(page: Page) {
  return page.getByRole("row").filter({ hasText: "pollIntervalMs" }).first();
}

test.beforeEach(async () => {
  await seed();
  await nameARepository();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a machine is connected by the person sitting at it, and the credential it is handed works", async ({
  page,
  request,
}) => {
  const started = await machineAsksToEnrol(request);

  // Nobody has approved anything yet, so the machine has nothing
  const tooEarly = await machineCollects(request, started.deviceCode);
  expect(tooEarly.status()).toBe(200);
  expect((await tooEarly.json()).state).toBe("pending");

  // A member, not an admin: enrolment is self-service, and whoever confirms it owns the machine
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto(started.path);

  await expect(page.getByRole("heading", { name: "Connect this machine?" })).toBeVisible();
  await expect(page.getByText(MACHINE.name)).toBeVisible();
  // The code on the screen has to be the code on the machine — that comparison is the whole
  // security of this exchange, and it is the operator who performs it
  await expect(page.getByText(started.userCode)).toBeVisible();

  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Connect it" }).click();
  await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();

  const collected = await machineCollects(request, started.deviceCode);
  expect(collected.status()).toBe(200);
  const enrolled = await collected.json();
  expect(enrolled.state).toBe("approved");
  expect(enrolled.projectKey).toBe(PROJECT_KEY);
  expect(enrolled.repositoryUrl).toBe(REPOSITORY);

  // The credential is worth something: a real request the server answers
  const answer = await machineReadsItsWork(request, enrolled);
  expect(answer.status(), await answer.text()).toBe(200);
  const view = await answer.json();

  // Nothing is assigned yet, and the machine is told where to clone *from* rather than where to
  // put it — an offer is an address
  expect(view.assignments).toHaveLength(0);
  expect(JSON.stringify(view.offers)).toContain(REPOSITORY);
  expect(decidedByTheServer(view)).not.toContain("path");

  // Now it has the checkout, so there is an assignment for the next assertion to be about. Without
  // this the "no path" check below reads an empty array and cannot fail — a mutation that added a
  // path to every assignment the server sends left it green, which is how this control got here.
  await machineReportsCheckouts(request, enrolled, [{ remote: REPOSITORY, path: CHECKOUT }]);
  const serving = await (await machineReadsItsWork(request, enrolled)).json();
  expect(serving.assignments.length).toBeGreaterThan(0);
  expect(JSON.stringify(serving.assignments)).toContain(REPOSITORY);

  // And still no path in anything the server decides: where the checkout lives stays the machine's
  // own business, and it travels one way only — the machine reported it a moment ago.
  expect(decidedByTheServer(serving)).not.toContain("path");
  expect(JSON.stringify(serving.repos)).toContain(CHECKOUT);

  // And the machine belongs to the person who confirmed it, which is what decides its reach
  expect(String((await workerRow(MACHINE.name))?.owner)).toBe(String(MEMBER_ID));
});

test("refusing hands the machine nothing", async ({ page, request }) => {
  const started = await machineAsksToEnrol(request);

  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto(started.path);
  await page.getByRole("button", { name: "Refuse" }).click();
  await expect(page.getByRole("heading", { name: "Refused" })).toBeVisible();

  const collected = await machineCollects(request, started.deviceCode);
  expect(collected.status()).toBe(410);
  expect((await collected.json()).credential).toBeUndefined();
  expect(await workerRow(MACHINE.name)).toBeNull();
});

test("a project that names no repository cannot be chosen, and says why", async ({
  page,
  request,
}) => {
  await nameARepository("");

  const started = await machineAsksToEnrol(request);
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto(started.path);

  await expect(page.getByText(/No project names a repository yet/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  // Nothing to choose means nothing to confirm, rather than a button that fails afterwards
  await expect(page.getByRole("button", { name: "Connect it" })).toBeDisabled();
});

test("the kill switch stops a credential that was working a moment ago", async ({
  page,
  request,
}) => {
  const machine = { workerId: String(WORKER_ID), credential: WORKER_CREDENTIAL };

  // The control, on the same credential and the same request as the refusal below
  expect((await machineReadsItsWork(request, machine)).status()).toBe(200);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await row.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(row.getByRole("button", { name: "Locked" })).toBeVisible();

  const refused = await machineReadsItsWork(request, machine);
  expect(refused.status()).toBe(403);
  // The machine is told to stop rather than to retry: without `abort` a killed worker sits in a
  // poll loop against a server that will never answer it
  expect((await refused.json()).abort).toBe(true);

  // And the switch is a switch, not a one-way door
  await row.getByRole("button", { name: "Locked" }).click();
  await expect(row.getByRole("button", { name: "Lock", exact: true })).toBeVisible();
  expect((await machineReadsItsWork(request, machine)).status()).toBe(200);
});

test("switching a machine off refuses it in the same way", async ({ page, request }) => {
  const machine = { workerId: String(WORKER_ID), credential: WORKER_CREDENTIAL };
  expect((await machineReadsItsWork(request, machine)).status()).toBe(200);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await row.getByRole("button", { name: "On", exact: true }).click();
  await expect(row.getByRole("button", { name: "Off", exact: true })).toBeVisible();

  // Two switches, two tests: removing either half of the guard reddens exactly one of them
  expect((await machineReadsItsWork(request, machine)).status()).toBe(403);
});

test("releasing a machine leaves it claiming nothing, and says so on the row", async ({
  page,
  request,
}) => {
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  const enrolled = await enrolAMachine(page, request);
  await machineReportsCheckouts(request, enrolled, [{ remote: REPOSITORY, path: CHECKOUT }]);
  // The control for the assertion at the end: while it has an owner, it has work
  expect((await (await machineReadsItsWork(request, enrolled)).json()).assignments.length)
    .toBeGreaterThan(0);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  const row = fleetRow(page, MACHINE.name);
  await expect(row.getByText("E2E Member")).toBeVisible();

  await row.getByTestId("worker-release").click();
  await page.getByRole("button", { name: "Release", exact: true }).click();

  await expect(row.getByTestId("worker-no-owner")).toHaveText("no owner — claims nothing");
  expect((await workerRow(MACHINE.name))?.owner ?? null).toBeNull();

  // The credential still answers — releasing is about whose work it may take, not about killing the
  // process on that machine. What it no longer has is anybody's reach.
  const answer = await machineReadsItsWork(request, enrolled);
  expect(answer.status()).toBe(200);
  expect((await answer.json()).assignments).toHaveLength(0);
});

test("a machine already enrolled to somebody else is refused, and the screen says so first", async ({
  browser,
  page,
  request,
}) => {
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await enrolAMachine(page, request);

  // The same name and host, now offered to a different account. The start route is
  // unauthenticated and takes any name, so this is a guess anybody could make.
  const second = await machineAsksToEnrol(request);
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, ADMIN_USERNAME, ADMIN_PASSWORD);
    await adminPage.goto(second.path);

    await expect(adminPage.getByTestId("belongs-to-somebody-else")).toBeVisible();

    // Said before the click, and then meant. Asserted on the status of the request the click makes:
    // a screen that stays put is also what a click that never fired looks like, and that is exactly
    // what this test did until a mutation of the ownership filter went unnoticed.
    await adminPage.getByRole("radio").first().check();
    const [attempt] = await Promise.all([
      adminPage.waitForResponse(
        (r) => r.url().includes("/approve") && r.request().method() === "POST"
      ),
      adminPage.getByRole("button", { name: "Connect it" }).click(),
    ]);
    expect(attempt.status(), await attempt.text()).toBe(409);

    const collected = await machineCollects(request, second.deviceCode);
    expect(collected.status()).toBe(200);
    expect((await collected.json()).state).toBe("pending");
    expect(String((await workerRow(MACHINE.name))?.owner)).toBe(String(MEMBER_ID));
  } finally {
    await adminContext.close();
  }
});

test("how often a machine asks is pinned on the machine, and the machine reads it", async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  await expect(policyRow(page).getByText("30s")).toBeVisible();
  await expect(policyRow(page).getByText("default", { exact: true }).first()).toBeVisible();

  // No screen edits this yet — the fleet page shows it and the app on the machine owns it — so the
  // gesture is the request that screen would make, carrying the admin's own session
  const patched = await page.request.patch(`/api/workers/${WORKER_ID}`, {
    headers: SAME_ORIGIN,
    data: { pollIntervalMs: 90_000 },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  await page.reload();
  await expect(policyRow(page).getByText("90s")).toBeVisible();
  // "set" rather than "default": a value pinned so a later change to the default cannot move it is
  // exactly what an operator is doing here, and only policyOverrides records that intent
  await expect(policyRow(page).getByText("set", { exact: true })).toBeVisible();

  // The half that matters: the machine is told, on the route it actually reads
  const answer = await machineReadsItsWork(request, {
    workerId: String(WORKER_ID),
    credential: WORKER_CREDENTIAL,
  });
  expect((await answer.json()).policy.pollIntervalMs).toBe(90_000);
});

test("the fleet page shows what a machine is running and when it was last heard from", async ({
  page,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");

  const row = fleetRow(page, WORKER_NAME);
  // The phase lives on the task and the machine on the worker; this column is the join, and the
  // only place a person can see that a machine is mid-run rather than idle
  await expect(row.getByText(HELD_TASK_KEY, { exact: true })).toBeVisible();
  await expect(row.getByText(RUN_PHASE, { exact: true })).toBeVisible();
  await expect(row.getByText("stale")).toHaveCount(0);

  await (await db())
    .collection("workers")
    .updateOne({ _id: WORKER_ID }, { $set: { lastSeenAt: new Date(Date.now() - 6 * 60_000) } });
  await page.reload();

  await expect(fleetRow(page, WORKER_NAME).getByText("stale")).toBeVisible();
});

test("a run refused for too large a diff is reported by the machine and read by a person", async ({
  page,
  request,
}) => {
  // Enrolled rather than seeded: a machine writes history as itself, and only registration gives it
  // the identity that write path requires — a seeded credential is refused with "no identity yet",
  // which a hand-made fixture would have quietly hidden.
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  const machine = await enrolAMachine(page, request);
  // A machine may write a project's history only where it serves that project, and it is the
  // machine that says where: it reports its checkouts and the server matches their remotes.
  await machineReportsCheckouts(request, machine, [{ remote: REPOSITORY, path: CHECKOUT }]);

  const reported = await request.post(`/api/projects/${PROJECT_KEY}/runs`, {
    headers: { ...SAME_ORIGIN, ...asMachine(machine) },
    data: {
      taskId: String(HELD_TASK_ID),
      taskKey: HELD_TASK_KEY,
      workerId: machine.workerId,
      agentName: "Default",
      outcome: "refused",
      refusedBy: "diff-size",
      detail: "the diff was 812 lines against a limit of 400",
      startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      costUsd: 0.42,
    },
  });
  expect(reported.status(), await reported.text()).toBe(201);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=workers`);

  const run = page.getByRole("row").filter({ hasText: HELD_TASK_KEY }).first();
  // Named, not counted: "a run failed" is not what a person needs. Which gate refused is the
  // difference between raising the limit and rewriting the change.
  await expect(run.getByText("Refused: diff-size")).toBeVisible();
  await expect(run.getByText("4 min")).toBeVisible();
  await expect(run.getByText("$0.42")).toBeVisible();
});
