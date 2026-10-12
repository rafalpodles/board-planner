import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  SHARED_KEY,
  asOrganisation,
  bearer,
  originOf,
  seedOrganisationWork,
  seedTwoOrganisations,
  signInOn,
  signInWithToken,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const { EJSON } = mongoose.mongo.BSON;
const id = (hex: string) => new mongoose.Types.ObjectId(hex);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const OWNER = { _id: id("e2e0000000000000000ac0a1"), username: "owner1", session: "cps_e2eac0a1deadbeefdeadbeefdeadbeef", token: "cp_e2eac0a1deadbeefdeadbeefdeadbeef" };
const MEMBER = { _id: id("e2e0000000000000000ac0a2"), username: "member1", session: "cps_e2eac0a2deadbeefdeadbeefdeadbeef", token: "cp_e2eac0a2deadbeefdeadbeefdeadbeef" };
const MOON = id("e2e0000000000000000ac0b1");
const WEBHOOK_TOKEN = "acme-receiver-token-1011";

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

// A second board in the same organisation, two people who are not instance admins, and the board's own
// agent, run, chat, secrets and uploads: everything the export has to take, and a neighbour it must not
async function seedExportWork(upload: (projectId: mongoose.Types.ObjectId, name: string) => Promise<void>) {
  await withDb(async (db) => {
    const now = new Date();
    const base = { organisation: ACME.organisation, createdAt: now, updatedAt: now };
    for (const person of [OWNER, MEMBER]) {
      await db.collection("users").insertOne({
        ...base,
        _id: person._id,
        username: person.username,
        password: bcrypt.hashSync(`${person.username}-password-1`, 4),
        fullName: `${person.username} person`,
        email: `${person.username}@acme.example`,
        emailNotifications: false,
        collapseEmptyColumns: false,
        kind: "human",
        role: "member",
      });
      await db.collection("sessions").insertOne({
        organisation: ACME.organisation,
        tokenHash: crypto.createHash("sha256").update(person.session).digest("hex"),
        user: person._id,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        lastUsedAt: now,
        userAgent: "",
        ip: "",
        createdAt: now,
      });
      await db.collection("apitokens").insertOne({
        organisation: ACME.organisation,
        user: person._id,
        name: `${person.username} token`,
        tokenHash: bcrypt.hashSync(person.token, 4),
        prefix: person.token.slice(0, 11),
        allowedProjects: [],
        lastUsedAt: null,
        createdAt: now,
      });
    }
    const main = await db.collection("projects").findOne({ _id: ACME.projectId });
    const { _id: _ignored, ...rest } = main!;
    await db.collection("projects").updateOne(
      { _id: ACME.projectId },
      { $set: { githubToken: "enc:v3:acme-key:githubsecret", webhooks: [{ name: "receiver", url: `https://hooks.example/${WEBHOOK_TOKEN}`, events: [] }] } }
    );
    await db.collection("projects").insertOne({ ...rest, _id: MOON, key: "MOON", name: "Acme Moonbase", taskCounter: 0 });
    await db.collection("grants").insertMany([
      { ...base, subject: OWNER._id, relation: "owner", objectType: "project", object: ACME.projectId, source: "manual" },
      { ...base, subject: MEMBER._id, relation: "member", objectType: "project", object: ACME.projectId, source: "manual" },
      { ...base, subject: OWNER._id, relation: "member", objectType: "project", object: MOON, source: "manual" },
    ]);

    const moonTask = id("e2e0000000000000000ac0b2");
    await db.collection("tasks").insertOne({
      ...base,
      _id: moonTask,
      project: MOON,
      taskNumber: 1,
      title: "moonbase task",
      description: "moonbase description",
      status: "todo",
      priority: "low",
      createdBy: ACME.adminId,
      checklist: [],
      relations: [],
      blockedBy: [],
      watchers: [],
    });
    await db.collection("comments").insertOne({ ...base, task: moonTask, author: OWNER._id, body: "moonbase comment", reactions: [] });
    await db.collection("activitylogs").insertOne({ ...base, task: moonTask, user: OWNER._id, action: "created", field: "", oldValue: "", newValue: "" });
    await db.collection("sprints").insertOne({ ...base, project: MOON, name: "moonbase sprint", startDate: now, endDate: now, goal: "", status: "planned" });
    await db.collection("projectauditlogs").insertOne({ ...base, project: MOON, user: OWNER._id, action: "settings_updated", detail: "moonbase settings" });

    const firstTask = (await db.collection("tasks").findOne({ project: ACME.projectId, taskNumber: 1001 }))!;
    // More than two pages of the export's 500 rows, so the paging by _id runs against the real database
    await db.collection("comments").insertMany(
      Array.from({ length: 1100 }, (_, n) => ({ ...base, task: firstTask._id, author: ACME.adminId, body: `acme bulk ${n}`, reactions: [] }))
    );
    for (const [project, label, task] of [
      [ACME.projectId, "rocket", firstTask._id],
      [MOON, "moonbase", moonTask],
    ] as const) {
      await db.collection("agents").insertOne({
        ...base,
        name: `${label} agent`,
        description: "",
        scope: "project",
        owner: null,
        project,
        composition: {},
        builtIn: false,
      });
      await db.collection("agentruns").insertOne({
        ...base,
        project,
        task,
        taskKey: `${SHARED_KEY}-1`,
        outcome: "merged",
        detail: `${label} run`,
        startedAt: now,
        finishedAt: now,
        costUsd: 0,
      });
      await db.collection("pmmessages").insertOne({ ...base, project, role: "user", content: `${label} chat`, actions: [], attachments: [] });
    }
  });
  await upload(ACME.projectId, "rocket.png");
  await upload(MOON, "moonbase.png");
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await seedOrganisationWork();
  await seedExportWork(async (projectId, name) => {
    const response = await request.post(`${ORGANISATIONS_API}/api/uploads`, {
      headers: { ...asOrganisation(ACME), ...bearer(ACME) },
      multipart: { file: { name, mimeType: "image/png", buffer: TINY_PNG }, projectId: String(projectId) },
    });
    expect(response.status(), await response.text()).toBe(200);
  });
  expect((await request.post(`${ORGANISATIONS_API}/api/e2e/organisation-cache`, { headers: asOrganisation(ACME) })).status()).toBe(204);
});

test.afterEach(async ({ request }) => {
  await request.post(`${ORGANISATIONS_API}/api/e2e/organisation-cache`, { headers: asOrganisation(ACME) });
});

type Line = { collection: string; document: Record<string, unknown> };

const idsOf = (rows: Record<string, unknown>[]) => rows.map((row) => String(row._id)).sort();

test.describe("exporting one project (BP-1011)", () => {
  test("its owner takes the project out from the settings page: its rows collection by collection, and nothing of another board or organisation", async ({ page }) => {
    await signInWithToken(page.context(), ACME, OWNER.session);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/settings?section=general`);
    const card = page.getByRole("button", { name: "Download the project export" });
    await expect(page.getByText("Loading who can use this board")).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp1011-project-export-desktop.png" });

    const [download] = await Promise.all([page.waitForEvent("download"), card.click()]);
    expect(download.suggestedFilename()).toMatch(/^same-export-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);
    const text = gunzipSync(readFileSync((await download.path())!)).toString("utf8");
    const [header, ...lines] = text.trim().split("\n").map((line) => EJSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({ format: "board-planner-project-export", version: 1 });
    expect(String(header.organisation)).toBe(ACME.organisation.toHexString());
    expect(String(header.project)).toBe(ACME.projectId.toHexString());

    const exported = new Map<string, Record<string, unknown>[]>();
    for (const { collection, document } of lines as unknown as Line[]) exported.set(collection, [...(exported.get(collection) ?? []), document]);

    const stored = await withDb(async (db) => {
      const project = ACME.projectId;
      const tasks = await db.collection("tasks").find({ project }).toArray();
      const taskIds = tasks.map((task) => task._id);
      const rows = (name: string, filter: object) => db.collection(name).find({ organisation: ACME.organisation, ...filter }).toArray();
      const files = await db.collection("uploads.files").find({ "metadata.project": { $in: [project, String(project)] } }).toArray();
      return {
        Project: await rows("projects", { _id: project }),
        Task: tasks,
        Comment: await rows("comments", { task: { $in: taskIds } }),
        ActivityLog: await rows("activitylogs", { task: { $in: taskIds } }),
        Sprint: await rows("sprints", { project }),
        ProjectAuditLog: await rows("projectauditlogs", { project }),
        Agent: await rows("agents", { scope: "project", project }),
        AgentRun: await rows("agentruns", { project }),
        PmMessage: await rows("pmmessages", { project }),
        Grant: await rows("grants", { objectType: "project", object: project }),
        "uploads.files": files,
        "uploads.chunks": await db.collection("uploads.chunks").find({ files_id: { $in: files.map((file) => file._id) } }).toArray(),
      };
    });
    for (const [name, rows] of Object.entries(stored)) {
      expect(rows.length, `${name} is in the seeded project`).toBeGreaterThan(0);
      expect(idsOf(exported.get(name) ?? []), `${name}: the export against the collection`).toEqual(idsOf(rows));
    }
    // The export is itself written down, before its first byte
    expect(stored.ProjectAuditLog.map((row) => row.action)).toContain("project_exported");

    const people = exported.get("User") ?? [];
    expect(people.map((person) => person.username).sort()).toEqual(["boss", MEMBER.username, OWNER.username]);
    for (const person of people) expect(Object.keys(person).sort()).toEqual(["_id", "fullName", "username"]);

    const project = exported.get("Project")![0];
    expect(project).not.toHaveProperty("githubToken");
    expect(JSON.stringify(project.webhooks)).not.toContain(WEBHOOK_TOKEN);

    for (const leak of ["moonbase", "Moonbase", "globex", GLOBEX.organisation.toHexString(), "enc:v3:", WEBHOOK_TOKEN, "@acme.example", "acme notice"]) {
      expect(text, `"${leak}" is not in the file`).not.toContain(leak);
    }
    expect(text).not.toMatch(/"[A-Za-z]*[Hh]ash"\s*:|"password"\s*:/);
    expect(text).toContain("acme first");
    expect(text).toContain("rocket chat");
  });

  test("a member of the board is offered no export, and the owner's card fits a phone", async ({ page }) => {
    await signInWithToken(page.context(), ACME, MEMBER.session);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/settings`);
    await expect(page.getByText("The rest of this project's settings need admin access.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download the project export" })).toHaveCount(0);
    await page.context().clearCookies();

    await page.setViewportSize({ width: 390, height: 844 });
    await signInWithToken(page.context(), ACME, OWNER.session);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/settings?section=general`);
    const button = page.getByRole("button", { name: "Download the project export" });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "e2e/.artifacts/bp1011-project-export-phone.png" });
  });

  test("a member, an API token and another organisation's board are refused, and the instance admin through a session is not", async ({ page, request }) => {
    const api = (who: { token: string }, path: string) =>
      request.get(`${ORGANISATIONS_API}${path}`, { headers: { ...asOrganisation(ACME), authorization: `Bearer ${who.token}` } });
    const check = `/api/projects/${ACME.projectId}/export?check=1`;

    // A member of the board is not its owner, whatever the credential
    expect((await api(MEMBER, check)).status()).toBe(403);
    // An owner's API token is a machine: the same refusal as the organisation's export
    const machine = await api(OWNER, check);
    expect(machine.status()).toBe(403);
    expect((await machine.json()).error).toMatch(/Interactive session/);
    // Another organisation's board, named by its id, is not found: not even for an administrator's token
    expect((await api({ token: ACME.apiToken }, `/api/projects/${GLOBEX.projectId}/export?check=1`)).status()).toBe(404);

    // The control: the administrator through a browser session is answered
    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/projects`);
    const own = await page.evaluate((path) => fetch(path).then((response) => response.status), check);
    expect(own).toBe(204);
    const foreign = await page.evaluate((path) => fetch(path).then((response) => response.status), `/api/projects/${GLOBEX.projectId}/export?check=1`);
    expect(foreign).toBe(404);
  });
});
