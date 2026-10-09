import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import type { BrowserContext } from "@playwright/test";
import { E2E_MONGODB_URI, PROJECT_ID, WORKER_CREDENTIAL, WORKER_ID, seed } from "./seed";
import { ORGANISATION_DOMAIN, ORGANISATIONS_PORT } from "../playwright.config";

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

export interface OrganisationFixture {
  slug: string;
  organisation: mongoose.Types.ObjectId;
  adminId: mongoose.Types.ObjectId;
  password: string;
  apiToken: string;
  sessionToken: string;
  projectId: mongoose.Types.ObjectId;
  projectName: string;
  workerId: mongoose.Types.ObjectId;
  oauthToken: string;
  notificationId: mongoose.Types.ObjectId;
}

export const USERNAME = "boss";
const OAUTH_CLIENT_ID = "e2e-organisations-client";
export const SHARED_KEY = "SAME";

export const ACME: OrganisationFixture = {
  slug: "acme",
  organisation: id("e2e0000000000000000ac000"),
  adminId: id("e2e0000000000000000ac001"),
  password: "acme-password-1",
  apiToken: "cp_e2eac001deadbeefdeadbeefdeadbeef",
  sessionToken: "cps_e2eac002deadbeefdeadbeefdeadbeef",
  projectId: id("e2e0000000000000000ac003"),
  projectName: "Acme Rockets",
  workerId: id("e2e0000000000000000ac004"),
  oauthToken: "cpat_e2eac005deadbeefdeadbeefdeadbeef",
  notificationId: id("e2e0000000000000000ac006"),
};

export const GLOBEX: OrganisationFixture = {
  slug: "globex",
  organisation: id("e2e0000000000000000ab000"),
  adminId: id("e2e0000000000000000ab001"),
  password: "globex-password-1",
  apiToken: "cp_e2eab001deadbeefdeadbeefdeadbeef",
  sessionToken: "cps_e2eab002deadbeefdeadbeefdeadbeef",
  projectId: id("e2e0000000000000000ab003"),
  projectName: "Globex Doomsday",
  workerId: id("e2e0000000000000000ab004"),
  oauthToken: "cpat_e2eab005deadbeefdeadbeefdeadbeef",
  notificationId: id("e2e0000000000000000ab006"),
};

export const hostOf = (who: OrganisationFixture | string) =>
  `${typeof who === "string" ? who : who.slug}.${ORGANISATION_DOMAIN}:${ORGANISATIONS_PORT}`;
export const originOf = (who: OrganisationFixture | string) => `http://${hostOf(who)}`;
export const PLATFORM_HOST = `${ORGANISATION_DOMAIN}:${ORGANISATIONS_PORT}`;
// Node resolves *.localhost unevenly across platforms, so API calls go to the loopback address and
// name the organisation in Host; the browser resolves *.localhost itself
export const ORGANISATIONS_API = `http://127.0.0.1:${ORGANISATIONS_PORT}`;

export const asOrganisation = (who: OrganisationFixture, extra: Record<string, string> = {}) => ({
  host: hostOf(who),
  "sec-fetch-site": "same-origin",
  ...extra,
});

export const bearer = (who: OrganisationFixture) => ({ authorization: `Bearer ${who.apiToken}` });

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

export async function seedTwoOrganisations(): Promise<void> {
  await seed();
  const handle = await db();
  const now = new Date();
  const template = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  const machine = await handle.collection("workers").findOne({ _id: WORKER_ID });
  const sha = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await handle.collection("oauthclients").insertOne({
    clientId: OAUTH_CLIENT_ID,
    clientName: "BP-670 client",
    redirectUris: ["http://localhost/callback"],
    createdAt: now,
  });
  for (const who of [ACME, GLOBEX]) {
    await handle.collection("organisations").insertOne({ _id: who.organisation, name: who.projectName.split(" ")[0], slug: who.slug });
    await handle.collection("users").insertOne({
      _id: who.adminId,
      organisation: who.organisation,
      username: USERNAME,
      password: bcrypt.hashSync(who.password, 4),
      fullName: `${who.slug} boss`,
      email: `boss@${who.slug}.example`,
      emailNotifications: false,
      collapseEmptyColumns: false,
      kind: "human",
      role: "admin",
      createdAt: now,
    });
    await handle.collection("apitokens").insertOne({
      organisation: who.organisation,
      user: who.adminId,
      name: `${who.slug} token`,
      tokenHash: bcrypt.hashSync(who.apiToken, 4),
      prefix: who.apiToken.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    });
    await handle.collection("sessions").insertOne({
      organisation: who.organisation,
      tokenHash: crypto.createHash("sha256").update(who.sessionToken).digest("hex"),
      user: who.adminId,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      lastUsedAt: now,
      userAgent: "",
      ip: "",
      createdAt: now,
    });
    const { _id: _machineId, ...machineRest } = machine!;
    await handle.collection("workers").insertOne({
      ...machineRest,
      _id: who.workerId,
      organisation: who.organisation,
      name: `${who.slug}-machine`,
      owner: who.adminId,
    });
    await handle.collection("oauthtokens").insertOne({
      organisation: who.organisation,
      accessTokenHash: sha(who.oauthToken),
      refreshTokenHash: sha(`${who.oauthToken}-refresh`),
      clientId: OAUTH_CLIENT_ID,
      user: who.adminId,
      scope: "mcp",
      allowedProjects: [],
      accessExpiresAt: later,
      refreshExpiresAt: later,
      createdAt: now,
    });
    await handle.collection("notifications").insertOne({
      _id: who.notificationId,
      organisation: who.organisation,
      recipient: who.adminId,
      type: "board_access",
      project: who.projectId,
      actor: who.adminId,
      title: `${who.slug} notice`,
      read: false,
      createdAt: now,
    });
    const { _id: _ignored, ...rest } = template!;
    await handle.collection("projects").insertOne({
      ...rest,
      _id: who.projectId,
      organisation: who.organisation,
      key: SHARED_KEY,
      name: who.projectName,
      taskCounter: 0,
    });
  }
  await mongoose.disconnect();
}

export const signInOn = (context: BrowserContext, who: OrganisationFixture): Promise<void> => signInWithToken(context, who, who.sessionToken);

/** The session cookie of somebody else in the organisation, whose session a spec has seeded */
export async function signInWithToken(context: BrowserContext, who: OrganisationFixture, sessionToken: string): Promise<void> {
  await context.addCookies([
    {
      name: "__Host-bp_session",
      value: sessionToken,
      domain: `${who.slug}.${ORGANISATION_DOMAIN}`,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

export const workerHeaders = (who: OrganisationFixture) => ({
  authorization: `Bearer ${WORKER_CREDENTIAL}`,
  "x-worker-id": String(who.workerId),
  "x-cp-protocol": "1",
});

export const oauthBearer = (who: OrganisationFixture) => ({ authorization: `Bearer ${who.oauthToken}` });

// The work and history of an organisation, apart from seedTwoOrganisations so the specs that count tasks on the seeded board stay as they are (BP-952)
export async function seedOrganisationWork(): Promise<void> {
  const handle = await db();
  const now = new Date();
  for (const who of [ACME, GLOBEX]) {
    const first = new mongoose.Types.ObjectId();
    const second = new mongoose.Types.ObjectId();
    const base = { organisation: who.organisation, createdAt: now, updatedAt: now };
    const taskBase = { ...base, project: who.projectId, createdBy: who.adminId };
    await handle.collection("tasks").insertMany([
      { ...taskBase, _id: first, taskNumber: 1001, title: `${who.slug} first`, description: `${who.slug} description`, status: "todo", priority: "medium", checklist: [{ text: `${who.slug} criterion`, done: false }], relations: [], blockedBy: [], watchers: [] },
      { ...taskBase, _id: second, taskNumber: 1002, title: `${who.slug} second`, description: "", status: "in_progress", priority: "high", checklist: [], relations: [{ task: first, type: "relates" }], blockedBy: [], watchers: [] },
    ]);
    await handle.collection("comments").insertMany([
      { ...base, task: first, author: who.adminId, body: `${who.slug} comment one`, reactions: [] },
      { ...base, task: second, author: who.adminId, body: `${who.slug} comment two`, reactions: [] },
    ]);
    await handle.collection("sprints").insertOne({ ...base, project: who.projectId, name: `${who.slug} sprint`, startDate: now, endDate: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000), goal: "", status: "planned" });
    await handle.collection("activitylogs").insertMany([
      { ...base, task: first, user: who.adminId, action: "created", field: "", oldValue: "", newValue: "" },
      { ...base, task: second, user: who.adminId, action: "created", field: "", oldValue: "", newValue: "" },
      { ...base, task: second, user: who.adminId, action: "status_changed", field: "status", oldValue: "todo", newValue: "in_progress" },
    ]);
    await handle.collection("projectauditlogs").insertOne({ ...base, project: who.projectId, user: who.adminId, action: "settings_updated", detail: `${who.slug} board settings` });
  }
  await mongoose.disconnect();
}
