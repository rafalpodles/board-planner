import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import http from "node:http";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { EXECUTION_LEASE_MS, MAX_EXECUTION_ATTEMPTS } from "@/lib/task-service";
import { BASE_URL } from "../playwright.config";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN, signInApi } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
  seedSecondProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-467. What an operator does to a machine once it is connected.
 *
 * `workers-enrolment.spec.ts` covers the handshake and the two switches that stop a machine
 * outright — lock and off — and proves each on a real request. Everything after that was driven by
 * nothing: the pause/resume/stop commands and the chip that reports them, the stream that pushes a
 * command ahead of the heartbeat, the phase a run reports and the badge that shows it, the lease
 * that takes a task off a machine that died, the enrolment-token path, the screen that decides
 * what a machine clones and deletes, and the admin-only gates in front of all of it.
 *
 * The seam under test is the same everywhere: **what the machine says on its own credential and
 * what a person reads on a screen have to be one fact.** A chip that reads "Paused" from the
 * console's own click, before the machine has said so, is the failure this file exists to catch —
 * an admin told a machine has stopped while it is mid-merge. So the machine's half is always a real
 * HTTP call on the seeded worker's credential, never a fixture write, and the person's half is the
 * screen; a fixture write is used only to reach a state the product cannot reach quickly (a lease
 * two hours old, a command sixty seconds unanswered).
 *
 * The one thing seeded rather than driven is the agent catalog: `seed()` wipes the database and
 * the app writes the built-in blocks at boot, so the claim tests insert the two blocks their agent
 * names. Without them `snapshotFor` resolves nothing and the claim route hands the task straight
 * back — which is a different test, and not this one.
 */

const PROTOCOL = "1";
const REPOSITORY = "https://github.com/rafalpodles/board-planner";
const SECOND_REPOSITORY = "https://github.com/rafalpodles/board-planner-site";
const CHECKOUT = "/Users/somebody/code/board-planner";
// The run seed() leaves holding TP-1 — mirrored, not imported, because seed.ts writes the literal
const HELD_RUN_ID = "e2e-run-0001";
const NEXT_RUN_ID = "e2e-run-0002";
const AGENT_NAME = "Board Runner";
const NEW_MACHINE = {
  name: "e2e-build-box",
  host: "build-box-2.local",
  platform: "linux",
  version: "0.0.0-e2e",
};

interface Machine {
  workerId: string;
  credential: string;
}

const SEEDED_MACHINE: Machine = { workerId: String(WORKER_ID), credential: WORKER_CREDENTIAL };

const cardHref = `/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function asMachine(machine: Machine = SEEDED_MACHINE) {
  return {
    Authorization: `Bearer ${machine.credential}`,
    "x-worker-id": machine.workerId,
    "x-cp-protocol": PROTOCOL,
  };
}

/** The machine reporting in, exactly as worker/src/registration.ts does — and reading its answer. */
async function heartbeat(request: APIRequestContext, body: Record<string, unknown> = {}) {
  const response = await request.post(`/api/workers/${WORKER_ID}/heartbeat`, {
    headers: asMachine(),
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** A run reporting where it is, for the task seed() left it holding. */
function reportPhase(
  request: APIRequestContext,
  event: { runId?: string; seq: number; phase: string }
) {
  return request.post(`/api/workers/${WORKER_ID}/events`, {
    headers: asMachine(),
    data: { taskId: String(HELD_TASK_ID), runId: HELD_RUN_ID, ...event },
  });
}

function machineReadsItsWork(request: APIRequestContext, machine: Machine = SEEDED_MACHINE) {
  return request.get(`/api/workers/${machine.workerId}`, { headers: asMachine(machine) });
}

function claim(request: APIRequestContext, runId: string) {
  return request.post(`/api/projects/${PROJECT_KEY}/tasks/claim`, {
    headers: asMachine(),
    data: { runId },
  });
}

function fleetRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name }).first();
}

/** The label a project occupies on the checkout picker; its checkbox and its hints live inside. */
function pickerRow(page: Page, projectName: string) {
  return page.locator("label").filter({ hasText: projectName });
}

async function workerRow() {
  return (await db()).collection("workers").findOne({ _id: WORKER_ID });
}

async function storedTask() {
  return (await db()).collection("tasks").findOne({ _id: HELD_TASK_ID });
}

async function projectRow(id: mongoose.Types.ObjectId) {
  return (await db()).collection("projects").findOne({ _id: id });
}

async function nameRepository(projectId: mongoose.Types.ObjectId, repositoryUrl: string) {
  await (await db()).collection("projects").updateOne({ _id: projectId }, { $set: { repositoryUrl } });
}

async function setWorker(fields: Record<string, unknown>) {
  await (await db()).collection("workers").updateOne({ _id: WORKER_ID }, { $set: fields });
}

async function setHeldTask(fields: Record<string, unknown>) {
  await (await db()).collection("tasks").updateOne({ _id: HELD_TASK_ID }, { $set: fields });
}

/**
 * The next poll of the fleet list that is SENT after this call — `waitForRequest`, not
 * `waitForResponse`, because a response arriving now may answer a request made before whatever
 * the caller just did. Returns what the console was told, so a negative claim about the chip can
 * be checked against the data it renders from rather than against a render that may not have
 * happened yet.
 */
async function pollAfter(page: Page): Promise<Record<string, unknown>[]> {
  const request = await page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/api/admin/workers"
  );
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json();
}

async function issueCommand(page: Page, row: ReturnType<typeof fleetRow>, command: string) {
  const [issued] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/workers/${WORKER_ID}/command` &&
        r.request().method() === "POST"
    ),
    row.getByRole("button", { name: command, exact: true }).click(),
  ]);
  expect(issued.status(), await issued.text()).toBe(200);
  return issued.json() as Promise<{ command: string; issuedAt: string }>;
}

interface Stream {
  status: number;
  contentType: string;
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

/**
 * The machine's SSE connection, held open by node:http rather than Playwright's request context,
 * which buffers a response to its end and so can never read a stream that has not ended.
 */
function openStream(machine: Machine = SEEDED_MACHINE): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${BASE_URL}/api/workers/${machine.workerId}/stream`,
      { headers: asMachine(machine) },
      (res) => {
        const queue: Record<string, unknown>[] = [];
        const waiting: ((event: Record<string, unknown>) => void)[] = [];
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
            // A comment line is the keep-alive ping, and not an event
            if (frame.startsWith(":")) continue;
            const lines = frame.split("\n");
            const name = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
            const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
            const event = { event: name, ...(data ? JSON.parse(data) : {}) };
            const waiter = waiting.shift();
            if (waiter) waiter(event);
            else queue.push(event);
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          next: (timeoutMs = 20_000) => {
            const queued = queue.shift();
            if (queued) return Promise.resolve(queued);
            return new Promise((resolveEvent, rejectEvent) => {
              const timer = setTimeout(
                () => rejectEvent(new Error(`no event on the stream within ${timeoutMs}ms`)),
                timeoutMs
              );
              waiting.push((event) => {
                clearTimeout(timer);
                resolveEvent(event);
              });
            });
          },
          close: () => req.destroy(),
        });
      }
    );
    req.on("error", reject);
  });
}

/**
 * Everything a claim needs from the seeded machine, none of which seed() gives it: an owner (the
 * admin, so the machine reaches every board), a checkout of the project's repository, the identity
 * user it acts as (the notification an abandoned run sends is written in that name, and is
 * silently skipped without it), and an agent the claim can resolve — with the two catalog blocks
 * it names, since seed() wiped the ones the app seeded at boot.
 */
const WORKER_IDENTITY_ID = new mongoose.Types.ObjectId("e2e00000000000000000a901");
const AGENT_ID = new mongoose.Types.ObjectId("e2e00000000000000000ab01");

async function makeTheMachineClaimCapable() {
  const handle = await db();
  const now = new Date();
  await nameRepository(PROJECT_ID, REPOSITORY);
  await setWorker({
    owner: ADMIN_ID,
    repos: [{ remote: REPOSITORY, path: CHECKOUT }],
    identity: WORKER_IDENTITY_ID,
    lastSeenAt: now,
  });
  await handle.collection("users").insertOne({
    _id: WORKER_IDENTITY_ID,
    username: `worker-${WORKER_ID}`,
    fullName: `E2E Admin · ${WORKER_NAME}`,
    password: bcrypt.hashSync("unused", 4),
    email: "",
    emailNotifications: false,
    kind: "machine",
    role: "member",
    createdAt: now,
  });
  const block = (over: Record<string, unknown>) => ({
    description: "",
    builtIn: true,
    gateKind: "",
    params: {},
    prompt: "",
    capability: "read-only",
    model: "",
    fallbackModel: "",
    deterministic: false,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  await handle.collection("agentblocks").insertMany([
    block({ key: "implement", kind: "step", name: "Implement", capability: "edit", prompt: "Make the change." }),
    block({ key: "push", kind: "step", name: "Push", deterministic: true }),
  ]);
  await handle.collection("agents").insertOne({
    _id: AGENT_ID,
    name: AGENT_NAME,
    description: "",
    scope: "project",
    owner: null,
    project: PROJECT_ID,
    builtIn: false,
    composition: {
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: [],
      delivery: [{ key: "push" }],
    },
    createdAt: now,
    updatedAt: now,
  });
}

/** TP-1 as a claim leaves it: handed by the owner to themselves, an agent named, a watcher on it. */
async function handedToTheMachine(execution: Record<string, unknown>) {
  await setHeldTask({
    assignee: ADMIN_ID,
    assignedBy: ADMIN_ID,
    agent: AGENT_ID,
    watchers: [MEMBER_ID],
    // What a real claim writes: the assignment is the person's, so a release hands it back
    "execution.assignedByRun": false,
    ...execution,
  });
}

/** Save, and what the route answered — the message on screen is built from it. */
async function save(
  page: Page
): Promise<{ projects: string[]; leftDisabled: string[]; refused: string[] }> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/workers/${WORKER_ID}/projects` &&
        r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

function wantedByProject(view: { catalogue: { project: string }[] }) {
  return new Map(view.catalogue.map((row) => [row.project, row]));
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("Pause reads as asked until the machine acknowledges it over heartbeat, and as done only then", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await expect(row.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // Nothing has been asked of this machine, so nothing is claimed about it
  await expect(row.getByText(/Pausing…|Paused/)).toHaveCount(0);

  const { issuedAt } = await issueCommand(page, row, "Pause");
  await expect(row.getByText("Pausing…", { exact: true })).toBeVisible();

  // The machine is told on its next heartbeat, and told when it was asked — the field it uses to
  // tell a repeated request apart from the same one seen twice
  const told = await heartbeat(request);
  expect(told.command).toBe("pause");
  expect(told.commandIssuedAt).toBe(issuedAt);

  // Reporting in is not acknowledging. Read off what the console is polled with, because a render
  // that has not happened yet looks the same as a chip that did not change.
  const polled = await pollAfter(page);
  expect(polled.find((w) => w._id === SEEDED_MACHINE.workerId)).toMatchObject({
    command: "pause",
    commandAckedAt: null,
  });
  await expect(row.getByText("Pausing…", { exact: true })).toBeVisible();

  await heartbeat(request, { acked: "pause" });
  await expect(row.getByText("Paused", { exact: true })).toBeVisible();
  const acked = await workerRow();
  expect(new Date(acked?.commandAckedAt).getTime()).toBeGreaterThan(new Date(issuedAt).getTime());

  // Stop is asked next. The machine's late acknowledgement of the PAUSE must not stand in for it:
  // that is the ack the heartbeat still carries from the previous cycle.
  await issueCommand(page, row, "Stop");
  await expect(row.getByText("Stopping…", { exact: true })).toBeVisible();
  await heartbeat(request, { acked: "pause" });
  expect((await pollAfter(page)).find((w) => w._id === SEEDED_MACHINE.workerId)).toMatchObject({
    command: "stop",
    commandAckedAt: null,
  });
  await expect(row.getByText("Stopping…", { exact: true })).toBeVisible();

  await heartbeat(request, { acked: "stop" });
  await expect(row.getByText("Stopped", { exact: true })).toBeVisible();
});

test("a command nobody acknowledged says so, and for how long", async ({ page }) => {
  // Sixty seconds is the threshold and a test cannot wait it out; the issue time is the one
  // fixture write here, and the ack that follows is what proves the reading is off the timestamps
  await setWorker({
    command: "stop",
    commandIssuedAt: new Date(Date.now() - 90_000),
    commandAckedAt: null,
  });

  await signIn(page);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  const chip = row.getByText(/^not acknowledged for \d+s$/);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/text-danger/);
  expect(Number((await chip.innerText()).match(/(\d+)s/)![1])).toBeGreaterThanOrEqual(90);

  // Acknowledged later than it was asked reads as done, however old the request
  await setWorker({ commandAckedAt: new Date(Date.now() - 30_000) });
  await page.reload();
  await expect(fleetRow(page, WORKER_NAME).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(fleetRow(page, WORKER_NAME).getByText(/not acknowledged/)).toHaveCount(0);
});

test("the emergency brake is a person's control: a machine credential, a member and a nonsense command are refused", async ({
  request,
}) => {
  const url = `/api/workers/${WORKER_ID}/command`;

  // An unscoped admin API token keeps role "admin" and sits on a disk the coding agent can read;
  // the counterpart switches were gated this way and this one was not (BP-306)
  const asToken = await request.post(url, { headers: ADMIN_AUTH, data: { command: "pause" } });
  expect(asToken.status()).toBe(403);
  expect((await asToken.json()).error).toBe("Interactive admin session required");

  const asMember = await request.post(url, { headers: MEMBER_AUTH, data: { command: "pause" } });
  expect(asMember.status()).toBe(403);

  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const nonsense = await request.post(url, { headers: SAME_ORIGIN, data: { command: "reboot" } });
  expect(nonsense.status()).toBe(400);
  expect((await nonsense.json()).error).toBe("command must be pause, resume or stop");

  // None of the three wrote anything the machine would read
  expect((await workerRow())?.command).toBe("");

  // The control, on the same session: a real command is taken
  const accepted = await request.post(url, { headers: SAME_ORIGIN, data: { command: "resume" } });
  expect(accepted.status(), await accepted.text()).toBe(200);
  expect((await workerRow())?.command).toBe("resume");
});

test("a command reaches the machine's open stream the moment it is issued, and a locked machine cannot open one", async ({
  page,
}) => {
  const stream = await openStream();
  expect(stream.status).toBe(200);
  expect(stream.contentType).toContain("text/event-stream");

  await signIn(page);
  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  try {
    const { issuedAt } = await issueCommand(page, row, "Pause");
    // The same issuance the heartbeat would report, pushed instead of polled
    expect(await stream.next()).toEqual({
      event: "command",
      command: "pause",
      commandIssuedAt: issuedAt,
    });
  } finally {
    stream.close();
  }

  // The kill switch closes this door too. Without the refusal a locked machine would keep a
  // channel the console still believes in, and only its heartbeat would be told to stop.
  await row.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(row.getByRole("button", { name: "Locked" })).toBeVisible();
  const refused = await openStream();
  refused.close();
  expect(refused.status).toBe(403);
});

test("a phase the machine reports over /events is what the card and the fleet console show, in seq order", async ({
  page,
  request,
}) => {
  const applied = await reportPhase(request, { seq: 8, phase: "gates:build" });
  expect(applied.status(), await applied.text()).toBe(200);
  expect(await applied.json()).toEqual({ applied: true });

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  const card = page.locator(`a[href="${cardHref}"]`);
  await expect(card.getByTestId("card-run-live")).toContainText("gates:build");

  // Overtaken: an older event landing late writes nothing, and is answered rather than refused —
  // a race is the expected outcome of fire-and-forget reporting, not an error the run reacts to
  const late = await reportPhase(request, { seq: 5, phase: "agent" });
  expect(late.status()).toBe(200);
  expect(await late.json()).toEqual({ applied: false });

  // A run that no longer holds the task writes nothing, however valid the credential
  const superseded = await reportPhase(request, {
    runId: "e2e-run-9999",
    seq: 9,
    phase: "gates:test-run",
  });
  expect(superseded.status()).toBe(200);
  expect(await superseded.json()).toEqual({ applied: false });

  // Not a label at all: no order, no text, a control character
  for (const bad of [
    { seq: 0, phase: "gates:review" },
    { seq: 9, phase: "" },
    { seq: 9, phase: "gates:\u0007review" },
  ]) {
    expect((await reportPhase(request, bad)).status(), JSON.stringify(bad)).toBe(400);
  }

  await page.reload();
  await expect(card.getByTestId("card-run-live")).toContainText("gates:build");

  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await expect(row.getByText(HELD_TASK_KEY, { exact: true })).toBeVisible();
  await expect(row.getByText("gates:build", { exact: true })).toBeVisible();

  // The kill switch reaches the run in flight: its next report is told to abort, and the board
  // keeps the last phase that was true rather than one the admin just stopped
  await row.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(row.getByRole("button", { name: "Locked" })).toBeVisible();
  const aborted = await reportPhase(request, { seq: 9, phase: "gates:review" });
  expect(aborted.status()).toBe(403);
  expect((await aborted.json()).abort).toBe(true);
  expect((await storedTask())?.execution).toMatchObject({
    runId: HELD_RUN_ID,
    phase: "gates:build",
    phaseSeq: 8,
  });
});

test("a run abandoned past the lease is handed back on the next claim, and that claim takes the task up again", async ({
  page,
  request,
}) => {
  await makeTheMachineClaimCapable();
  await handedToTheMachine({});

  // The control: the run is silent but within its lease, so the claim finds nothing and touches
  // nothing — a sweep that ignored the lease would be caught here
  const early = await claim(request, NEXT_RUN_ID);
  expect(early.status(), await early.text()).toBe(204);
  expect((await storedTask())?.execution).toMatchObject({ runId: HELD_RUN_ID, attempts: 1 });

  await setHeldTask({ "execution.startedAt": new Date(Date.now() - EXECUTION_LEASE_MS - 60_000) });

  const reclaimed = await claim(request, NEXT_RUN_ID);
  expect(reclaimed.status(), await reclaimed.text()).toBe(200);
  const handed = await reclaimed.json();
  expect(handed.taskNumber).toBe(HELD_TASK_NUMBER);
  expect(handed.agent.name).toBe(AGENT_NAME);

  const stored = await storedTask();
  expect(stored?.status).toBe("in_progress");
  // A second attempt, not a first: the one that outlived its worker is not refunded, so a task
  // that keeps doing so runs out and reaches a person rather than cycling forever
  expect(stored?.execution).toMatchObject({
    runId: NEXT_RUN_ID,
    workerId: SEEDED_MACHINE.workerId,
    attempts: 2,
  });
  expect(stored?.execution.phase).toBeUndefined();
  // The person's assignment survived the release — it was theirs, not the run's
  expect(String(stored?.assignee)).toBe(String(ADMIN_ID));

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  const card = page.getByTestId("column-in_progress").locator(`a[href="${cardHref}"]`);
  await expect(card).toBeVisible();
  // A fresh run that has not reported yet, not the old run's last phase
  await expect(card.getByTestId("card-run-live")).toContainText("starting");

  await page.goto("/settings/workers");
  const row = fleetRow(page, WORKER_NAME);
  await expect(row.getByText(HELD_TASK_KEY, { exact: true })).toBeVisible();
  await expect(row.getByText("starting", { exact: true })).toBeVisible();
});

test("a run out of attempts is parked for a person, off the machine, and the watchers are told in the machine's name", async ({
  page,
  request,
}) => {
  await makeTheMachineClaimCapable();
  await handedToTheMachine({
    "execution.attempts": MAX_EXECUTION_ATTEMPTS,
    "execution.startedAt": new Date(Date.now() - EXECUTION_LEASE_MS - 60_000),
  });

  // Swept, and then nothing left to take: the parked task is not in the approved column any more
  const swept = await claim(request, "e2e-run-0003");
  expect(swept.status(), await swept.text()).toBe(204);

  const stored = await storedTask();
  expect(stored?.status).toBe("needs_human_review");
  expect(stored?.execution.runId).toBeUndefined();
  expect(stored?.execution.attempts).toBe(MAX_EXECUTION_ATTEMPTS);
  expect(String(stored?.assignee)).toBe(String(ADMIN_ID));

  await signIn(page, "member");
  await page.goto(`/projects/${PROJECT_KEY}`);
  const card = page.getByTestId("column-needs_human_review").locator(`a[href="${cardHref}"]`);
  await expect(card).toBeVisible();
  await expect(
    card.locator('[data-testid="card-run-live"], [data-testid="card-run-quiet"]')
  ).toHaveCount(0);

  // The move had no actor and went through updateMany, so this row is the only way anybody hears.
  // Written fire-and-forget, so the feed is reloaded until it is there.
  await expect(async () => {
    await page.goto("/notifications");
    const rows = page.locator("#main-content").locator(`a[href="${cardHref}"]`);
    await expect(rows).toHaveCount(1, { timeout: 3_000 });
    await expect(rows).toContainText(`${HELD_TASK_KEY} needs a human — the run was abandoned`);
  }).toPass({ timeout: 30_000 });

  // And the fleet console no longer shows the machine running it. The machine's own row is waited
  // for first: until /api/admin/workers answers, this page is a spinner with no rows at all, and
  // "the task key is not on the row" holds trivially there — the same silence a working sweep
  // produces.
  await signIn(page);
  await page.goto("/settings/workers");
  await expect(fleetRow(page, WORKER_NAME).getByText(WORKER_NAME)).toBeVisible();
  // Any task key, not just this one. The Running cell reports a single task per machine, chosen
  // newest-claim-first, and this board leaves a *finished* run on TP-4 whose workerId is the same
  // machine — so a regression that stopped filtering on a live runId would fill this cell with
  // TP-4 and leave "TP-1 is not here" perfectly true. Measured: naming the key alone let exactly
  // that mutation through green.
  await expect(fleetRow(page, WORKER_NAME).getByText(/^TP-\d+$/)).toHaveCount(0);
});

test("an admin mints a single-use enrolment token, and a machine spends it on a credential that works", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto("/settings/workers");
  await page.getByRole("button", { name: "Enrol a worker" }).click();
  const dialog = page.getByRole("dialog", { name: "Enrol a worker" });
  await dialog.getByLabel("Label (optional)").fill("build-box-2");
  const [minted] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/workers/enrolment" && r.request().method() === "POST"
    ),
    dialog.getByRole("button", { name: "Mint token" }).click(),
  ]);
  expect(minted.status(), await minted.text()).toBe(201);

  const token = (await dialog.getByText(/^cpe_[0-9a-f]+$/).innerText()).trim();
  expect(token).toMatch(/^cpe_[0-9a-f]{48}$/);
  await expect(dialog.getByText(/Single use · expires in (59|60) min/)).toBeVisible();

  const register = (headers: Record<string, string>, data: Record<string, unknown>) =>
    request.post("/api/workers/register", {
      headers: { Authorization: `Bearer ${token}`, "x-cp-protocol": PROTOCOL, ...headers },
      data,
    });

  // Shape and protocol are checked before the token is spent: an operator gets one, and burning
  // it on a typo would mean minting another
  const wrongProtocol = await register({ "x-cp-protocol": "0" }, NEW_MACHINE);
  expect(wrongProtocol.status()).toBe(409);
  const noHost = await register({}, { name: NEW_MACHINE.name });
  expect(noHost.status()).toBe(400);

  const registered = await register({}, NEW_MACHINE);
  expect(registered.status(), await registered.text()).toBe(200);
  const machine: Machine & { assignments: unknown[] } = await registered.json();
  expect(machine.credential).toMatch(/^cpw_/);
  // Nothing reported yet, so nothing matched
  expect(machine.assignments).toEqual([]);

  // Spent: the same string buys nothing a second time, and one message covers every failure
  const again = await register({}, { ...NEW_MACHINE, name: "e2e-build-box-2" });
  expect(again.status()).toBe(401);
  expect((await again.json()).error).toBe("Invalid or spent enrolment token");

  // The credential is worth something: a real request the server answers
  const answer = await machineReadsItsWork(request, machine);
  expect(answer.status(), await answer.text()).toBe(200);

  // The machine belongs to whoever minted the token, and the fleet says so
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  const row = fleetRow(page, NEW_MACHINE.name);
  await expect(row.getByText(NEW_MACHINE.host)).toBeVisible();
  await expect(row.getByText("E2E Admin")).toBeVisible();

  // Both halves are on the record: who minted, and which host spent it
  await page.goto("/settings/audit");
  await expect(
    page.getByRole("row").filter({ hasText: "Enrolment token minted" }).first()
  ).toContainText("build-box-2");
  const spent = page.getByRole("row").filter({ hasText: "Enrolment token spent" }).first();
  await expect(spent).toContainText(NEW_MACHINE.name);
  await expect(spent).toContainText(`Registered ${NEW_MACHINE.host}`);

  // A machine credential cannot mint: a token readable off the worker's disk that could would hand
  // back the very power enrolment tokens exist to remove
  const asToken = await request.post("/api/workers/enrolment", { headers: ADMIN_AUTH, data: {} });
  expect(asToken.status()).toBe(403);
  expect((await asToken.json()).error).toBe("Interactive session required");
});

test("the checkout picker: what a machine has, what it is given, and what saving takes away", async ({
  page,
  request,
}) => {
  await seedSecondProject();
  await nameRepository(SECOND_PROJECT_ID, SECOND_REPOSITORY);
  await setWorker({ owner: ADMIN_ID });

  await signIn(page);
  await page.goto(`/settings/workers/${WORKER_ID}/projects`);
  await expect(page.getByRole("heading", { name: `Projects for ${WORKER_NAME}` })).toBeVisible();

  // The seeded board names no repository, so there is nothing to clone — shown and disabled
  // rather than hidden, with the fix named
  const tp = pickerRow(page, PROJECT_NAME);
  await expect(tp.getByRole("checkbox")).toBeDisabled();
  await expect(
    tp.getByText("no repository set — add one under the project's Integrations settings")
  ).toBeVisible();

  // Once it does, and the machine reports a checkout of it, the row is connected and ticked: with
  // nothing chosen yet, what the machine wants is what it already has
  await nameRepository(PROJECT_ID, REPOSITORY);
  await heartbeat(request, { repos: [{ remote: REPOSITORY, path: CHECKOUT }] });
  await page.reload();
  await expect(tp.getByRole("checkbox")).toBeEnabled();
  await expect(tp.getByRole("checkbox")).toBeChecked();
  await expect(tp.getByText("connected")).toBeVisible();

  const ib = pickerRow(page, SECOND_PROJECT_NAME);
  await expect(ib.getByRole("checkbox")).not.toBeChecked();
  await expect(ib.getByText("does not run machines yet — ticking it turns that on")).toBeVisible();

  await ib.getByRole("checkbox").check();
  await expect(
    page.getByText(
      "One project will be cloned by the app the next time it looks — which is right after you save."
    )
  ).toBeVisible();
  const saved = await save(page);
  expect(saved).toMatchObject({ leftDisabled: [], refused: [] });
  expect([...saved.projects].sort()).toEqual([String(PROJECT_ID), String(SECOND_PROJECT_ID)].sort());
  await expect(page.getByText("Saved. The app picks this up and sets up the checkouts.")).toBeVisible();

  // Ticking it turned workers on for that project, which is an instance-admin act and audited as one
  expect((await projectRow(SECOND_PROJECT_ID))?.worker.enabled).toBe(true);
  await page.reload();
  // The row itself first: this screen renders "Loading…" and no labels at all until its own fetch
  // resolves, and a warning that is absent because nothing has rendered reads exactly like a
  // warning that is gone
  await expect(pickerRow(page, SECOND_PROJECT_NAME).getByRole("checkbox")).toBeChecked();
  await expect(pickerRow(page, SECOND_PROJECT_NAME).getByText(/does not run machines/)).toHaveCount(0);

  // The machine reads the same decision on its own route — the one it clones from
  const catalogue = wantedByProject(await (await machineReadsItsWork(request)).json());
  expect(catalogue.get(String(PROJECT_ID))).toMatchObject({ wanted: true, servedHere: true });
  expect(catalogue.get(String(SECOND_PROJECT_ID))).toMatchObject({
    wanted: true,
    servedHere: false,
    workersEnabled: true,
  });

  // Unticking a checkout the machine has is a delete on somebody's disk, and the screen says so by
  // name before the save that does it
  await pickerRow(page, PROJECT_NAME).getByRole("checkbox").uncheck();
  const warning = page
    .locator("div")
    .filter({ hasText: /^Saving removes a checkout from this machine:/ })
    .first();
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("listitem")).toHaveText([`${PROJECT_NAME} · ${PROJECT_KEY}`]);
  await expect(warning).toContainText("refuses any checkout with uncommitted changes");

  const removed = await save(page);
  expect(removed.projects).toEqual([String(SECOND_PROJECT_ID)]);
  const after = wantedByProject(await (await machineReadsItsWork(request)).json());
  // Still reported — the app has not acted yet — and no longer wanted, which is the request to
  // remove it
  expect(after.get(String(PROJECT_ID))).toMatchObject({ wanted: false, servedHere: true });
  expect(after.get(String(SECOND_PROJECT_ID))).toMatchObject({ wanted: true });

  await page.goto("/settings/audit");
  const enabled = page.getByRole("row").filter({ hasText: "Workers enabled for project" }).first();
  await expect(enabled).toContainText(SECOND_PROJECT_KEY);
  await expect(enabled).toContainText(`Picked for ${WORKER_NAME}`);
});

test("a member picks for their own machine; what they cannot switch on is said, not done, and a colleague's machine is not found", async ({
  page,
  request,
}) => {
  await seedSecondProject();
  await nameRepository(PROJECT_ID, REPOSITORY);
  await nameRepository(SECOND_PROJECT_ID, SECOND_REPOSITORY);
  await setWorker({ owner: MEMBER_ID, repos: [{ remote: REPOSITORY, path: CHECKOUT }] });
  const handle = await db();
  // A grant on the switched-off board, so it is in the member's reach and on the screen — the row
  // whose switch they cannot throw
  await handle.collection("grants").insertOne({
    subject: MEMBER_ID,
    relation: "member",
    objectType: "project",
    object: SECOND_PROJECT_ID,
    createdBy: ADMIN_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A colleague's machine, for the refusal at the end
  const othersId = new mongoose.Types.ObjectId();
  await handle.collection("workers").insertOne({
    ...(await workerRow()),
    _id: othersId,
    name: "e2e-somebody-elses",
    owner: ADMIN_ID,
  });

  await signIn(page, "member");
  await page.goto(`/settings/workers/${WORKER_ID}/projects`);
  await expect(page.getByRole("heading", { name: `Projects for ${WORKER_NAME}` })).toBeVisible();
  const ib = pickerRow(page, SECOND_PROJECT_NAME);
  await expect(
    ib.getByText("does not run machines yet, and only an instance admin can turn that on")
  ).toBeVisible();

  await ib.getByRole("checkbox").check();
  const saved = await save(page);
  expect(saved.leftDisabled).toEqual([SECOND_PROJECT_KEY]);
  await expect(
    page.getByText(
      `Saved. ${SECOND_PROJECT_KEY} does not run machines yet, and only an instance admin can turn that on — the machine will leave it alone until somebody does.`
    )
  ).toBeVisible();
  // The wish is recorded and the switch is not thrown
  expect((await projectRow(SECOND_PROJECT_ID))?.worker.enabled).toBe(false);
  expect((await workerRow())?.desiredProjects.map(String).sort()).toEqual(
    [String(PROJECT_ID), String(SECOND_PROJECT_ID)].sort()
  );

  // A board outside the reach is refused by id and not stored, whatever the screen was told
  const outside = String(new mongoose.Types.ObjectId());
  const pushed = await page.request.put(`/api/workers/${WORKER_ID}/projects`, {
    headers: SAME_ORIGIN,
    data: { projects: [String(PROJECT_ID), outside] },
  });
  expect(pushed.status(), await pushed.text()).toBe(200);
  expect(await pushed.json()).toMatchObject({ projects: [String(PROJECT_ID)], refused: [outside] });
  expect((await workerRow())?.desiredProjects.map(String)).toEqual([String(PROJECT_ID)]);

  // The screen that decides what a machine clones is closed to machines: the worker's own
  // credential is not a person's at all, and a person's API token is refused as a machine's
  const asTheMachine = await request.get(`/api/workers/${WORKER_ID}/projects`, {
    headers: asMachine(),
  });
  expect(asTheMachine.status()).toBe(401);
  const asAToken = await request.put(`/api/workers/${WORKER_ID}/projects`, {
    headers: MEMBER_AUTH,
    data: { projects: [] },
  });
  expect(asAToken.status()).toBe(403);

  // Somebody else's machine answers as a wrong guess would
  await page.goto(`/settings/workers/${othersId}/projects`);
  await expect(page.getByText("Worker not found")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("a plain member is bounced off every admin-only worker screen, and the routes behind them refuse too", async ({
  page,
  request,
}) => {
  await signIn(page, "member");

  for (const [path, heading] of [
    ["/settings/workers", "Worker fleet"],
    ["/settings/workers/runs", "Run history"],
    ["/settings/agents", "PM agents"],
  ] as const) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);
  }

  // The nav is honest about it: no Administration group is offered
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workers", exact: true })).toHaveCount(0);
  await expect(page.getByText("Administration")).toHaveCount(0);

  // The routes the screens read, on the member's own credential
  const fleet = await request.get("/api/admin/workers", { headers: MEMBER_AUTH });
  expect(fleet.status()).toBe(403);
  const runs = await request.get("/api/admin/runs", { headers: MEMBER_AUTH });
  expect(runs.status()).toBe(403);

  // The run history carries every project's run detail, so an admin's API token is refused too —
  // and the fleet list on the same token is the control that it is the token, not the role
  const runsOnToken = await request.get("/api/admin/runs", { headers: ADMIN_AUTH });
  expect(runsOnToken.status()).toBe(403);
  expect((await runsOnToken.json()).error).toBe("Interactive admin session required");
  expect((await request.get("/api/admin/workers", { headers: ADMIN_AUTH })).status()).toBe(200);
});

test("the run history reads a finished run's project, agent, machine, outcome, duration and cost", async ({
  page,
}) => {
  const handle = await db();
  const now = Date.now();
  const run = (over: Record<string, unknown>) => ({
    project: PROJECT_ID,
    task: HELD_TASK_ID,
    taskKey: HELD_TASK_KEY,
    worker: WORKER_ID,
    agent: null,
    agentName: AGENT_NAME,
    refusedBy: "",
    detail: "",
    costUsd: 0,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...over,
  });
  await handle.collection("agentruns").insertMany([
    // Inserted oldest first, so the newest-first order on screen is the sort and not the scan
    run({
      outcome: "merged",
      worker: null,
      agentName: "",
      costUsd: 0.5,
      startedAt: new Date(now - 30 * 60_000),
      finishedAt: new Date(now - 10 * 60_000),
    }),
    run({
      outcome: "delivered",
      detail: "Opened pull request #12",
      costUsd: 1.234,
      startedAt: new Date(now - 5 * 60_000),
      finishedAt: new Date(now - 60_000),
    }),
  ]);

  await signIn(page);
  await page.goto("/settings/workers/runs");
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();

  const delivered = page.getByRole("row").filter({ hasText: "Pull request open" });
  await expect(delivered).toHaveCount(1);
  for (const cell of [HELD_TASK_KEY, PROJECT_NAME, AGENT_NAME, WORKER_NAME, "4 min", "$1.23"]) {
    await expect(delivered, cell).toContainText(cell);
  }
  await expect(delivered.getByText("Pull request open")).toHaveClass(/text-success/);
  await expect(page.getByTestId("run-detail")).toHaveText("Opened pull request #12");

  // A run filed by hand, or before the machine reported itself: blank cells are the honest answer
  const merged = page.getByRole("row").filter({ hasText: "Merged" });
  await expect(merged).toHaveCount(1);
  await expect(merged).toContainText("20 min");
  await expect(merged).toContainText("$0.50");
  await expect(merged.getByText("—", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("run-detail-empty")).toHaveText(
    "Nothing was recorded about how this run ended."
  );

  // Newest first
  const order = await page.locator("tbody tr").filter({ hasText: / min/ }).allInnerTexts();
  expect(order.map((text) => (text.includes("Pull request open") ? "delivered" : "merged"))).toEqual([
    "delivered",
    "merged",
  ]);
});

/**
 * BP-504. A checkout carrying a key git would run on checkout is quarantined by the worker: it
 * stops claiming for every project bound to that path until an operator removes the key and
 * restarts. The half a person can reach is this screen — and until BP-504 the account of it lived
 * only on the worker's own stderr and a socket field the menubar does not decode, so a machine
 * that had deliberately stopped serving a project read `ready` here.
 *
 * Driven through the real heartbeat rather than a fixture write: the report has to survive the
 * route's own parsing to reach the row, which a direct write would skip.
 */
test("a machine that quarantined a checkout says so on the fleet screen, not `ready`", async ({
  page,
  request,
}) => {
  const CHECKOUT = "/Users/e2e/repos/demo";
  const KEY = "filter.z.smudge (worktree)";

  // The control first, on the same row and the same screen: a machine whose checks all pass reads
  // ready. Without it a cell that failed to render anything at all would satisfy the assertions
  // below by never containing the word.
  await heartbeat(request, {
    preflight: { ok: true, account: "rafalpodles", checks: [{ name: "gh", ok: true, detail: "" }] },
  });

  await signIn(page);
  await page.goto("/settings/workers");
  await expect(fleetRow(page, WORKER_NAME).getByText(/^ready/)).toBeVisible();

  // Now the same machine reports what wiring.ts composes when a run refuses a poisoned checkout
  await heartbeat(request, {
    preflight: {
      ok: false,
      account: "rafalpodles",
      checks: [
        { name: "gh", ok: true, detail: "" },
        {
          name: "checkout quarantined",
          ok: false,
          detail: `${CHECKOUT}: its git config carries ${KEY}. Remove the key, then restart this worker.`,
        },
      ],
    },
  });

  await page.reload();
  const row = fleetRow(page, WORKER_NAME);
  await expect(row.getByText("checkout quarantined")).toBeVisible();
  // The three things an operator needs off this screen without opening a terminal: which checkout,
  // what is in it, and the way out.
  await expect(row).toContainText(CHECKOUT);
  await expect(row).toContainText(KEY);
  await expect(row).toContainText("restart this worker");
  await expect(row.getByText(/^ready/), "the machine still reads ready").toHaveCount(0);
});
