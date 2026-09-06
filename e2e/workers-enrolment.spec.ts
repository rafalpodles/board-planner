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

async function machineAsksToEnrol(request: APIRequestContext, machine = MACHINE) {
  const response = await request.post("/api/workers/enrolment/device", {
    headers: { ...SAME_ORIGIN, "x-cp-protocol": PROTOCOL },
    data: machine,
  });
  expect(response.status(), await response.text()).toBe(201);
  const started = await response.json();
  return { ...started, path: new URL(started.verificationUrl).pathname };
}

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

async function machineReadsItsWork(request: APIRequestContext, machine: Machine) {
  return request.get(`/api/workers/${machine.workerId}`, { headers: asMachine(machine) });
}

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

async function machineRecordsRun(
  request: APIRequestContext,
  machine: Machine,
  run: { outcome: string; refusedBy?: string; detail?: string }
) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/runs`, {
    headers: { ...SAME_ORIGIN, ...asMachine(machine) },
    data: {
      taskId: String(HELD_TASK_ID),
      taskKey: HELD_TASK_KEY,
      workerId: machine.workerId,
      agentName: "Default",
      refusedBy: "",
      detail: "",
      startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      costUsd: 0.42,
      ...run,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

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

  const tooEarly = await machineCollects(request, started.deviceCode);
  expect(tooEarly.status()).toBe(200);
  expect((await tooEarly.json()).state).toBe("pending");

  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto(started.path);

  await expect(page.getByRole("heading", { name: "Connect this machine?" })).toBeVisible();
  await expect(page.getByText(MACHINE.name)).toBeVisible();
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

  const answer = await machineReadsItsWork(request, enrolled);
  expect(answer.status(), await answer.text()).toBe(200);
  const view = await answer.json();

  expect(view.assignments).toHaveLength(0);
  expect(JSON.stringify(view.offers)).toContain(REPOSITORY);
  expect(decidedByTheServer(view)).not.toContain("path");

  await machineReportsCheckouts(request, enrolled, [{ remote: REPOSITORY, path: CHECKOUT }]);
  const serving = await (await machineReadsItsWork(request, enrolled)).json();
  expect(serving.assignments.length).toBeGreaterThan(0);
  expect(JSON.stringify(serving.assignments)).toContain(REPOSITORY);

  expect(decidedByTheServer(serving)).not.toContain("path");
  expect(JSON.stringify(serving.repos)).toContain(CHECKOUT);

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
  await expect(page.getByRole("button", { name: "Connect it" })).toBeDisabled();
});

test("the project pick is framed as a first checkout, not as what the machine may work on", async ({
  page,
  request,
}) => {
  const started = await machineAsksToEnrol(request);
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  await page.goto(started.path);

  const pick = page.locator("section").filter({ has: page.getByRole("radio") });
  await expect(
    pick.getByRole("heading", { name: "Which repository should it set up first?" })
  ).toBeVisible();
  await expect(page.getByText(/which project should it work on/i)).toHaveCount(0);

  await expect(pick.getByText(/reaches every project you can/)).toBeVisible();

  await expect(pick.getByRole("radio")).toHaveCount(1);
  await expect(pick.getByRole("checkbox")).toHaveCount(0);

  await pick.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Connect it" }).click();

  await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();
  await expect(page.getByText(/Settings . Workers/)).toBeVisible();

  const collected = await machineCollects(request, started.deviceCode);
  const enrolled = await collected.json();
  expect(enrolled.projectKey).toBe(PROJECT_KEY);
  expect(enrolled.repositoryUrl).toBe(REPOSITORY);
});

test("the kill switch stops a credential that was working a moment ago", async ({
  page,
  request,
}) => {
  const machine = { workerId: String(WORKER_ID), credential: WORKER_CREDENTIAL };

  expect((await machineReadsItsWork(request, machine)).status()).toBe(200);

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await row.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(row.getByRole("button", { name: "Locked" })).toBeVisible();

  const refused = await machineReadsItsWork(request, machine);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).abort).toBe(true);

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

  expect((await machineReadsItsWork(request, machine)).status()).toBe(403);
});

test("releasing a machine leaves it claiming nothing, and says so on the row", async ({
  page,
  request,
}) => {
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  const enrolled = await enrolAMachine(page, request);
  await machineReportsCheckouts(request, enrolled, [{ remote: REPOSITORY, path: CHECKOUT }]);
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

  const second = await machineAsksToEnrol(request);
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, ADMIN_USERNAME, ADMIN_PASSWORD);
    await adminPage.goto(second.path);

    await expect(adminPage.getByTestId("belongs-to-somebody-else")).toBeVisible();

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

  const patched = await page.request.patch(`/api/workers/${WORKER_ID}`, {
    headers: SAME_ORIGIN,
    data: { pollIntervalMs: 90_000 },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  await page.reload();
  await expect(policyRow(page).getByText("90s")).toBeVisible();
  await expect(policyRow(page).getByText("set", { exact: true })).toBeVisible();

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
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  const machine = await enrolAMachine(page, request);
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
  await expect(run.getByText("Refused: diff-size")).toBeVisible();
  await expect(run.getByText("4 min")).toBeVisible();
  await expect(run.getByText("$0.42")).toBeVisible();
});

test("what a finished run said is read from the fleet page, not out of the database", async ({
  page,
  request,
}) => {
  await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
  const machine = await enrolAMachine(page, request);
  await machineReportsCheckouts(request, machine, [{ remote: REPOSITORY, path: CHECKOUT }]);

  const REASON = "the build failed: 2 tests red in src/lib/gates.test.ts";
  await machineRecordsRun(request, machine, { outcome: "failed", detail: REASON });
  await machineRecordsRun(request, machine, { outcome: "refused", refusedBy: "diff-size" });

  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/settings/workers");
  await page.getByRole("link", { name: "Run history" }).click();

  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  await expect(page.getByTestId("run-detail")).toHaveText(REASON);
  await expect(page.getByRole("row").filter({ hasText: "Failed" }).first()).toContainText(
    MACHINE.name
  );

  await expect(page.getByText("Refused: diff-size")).toBeVisible();
  await expect(page.getByTestId("run-detail-empty")).toContainText("diff-size");
});
