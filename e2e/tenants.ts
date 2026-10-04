import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import type { BrowserContext } from "@playwright/test";
import { E2E_MONGODB_URI, PROJECT_ID, WORKER_CREDENTIAL, WORKER_ID, seed } from "./seed";
import { TENANT_DOMAIN, TENANTS_PORT } from "../playwright.config";

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

export interface TenantFixture {
  slug: string;
  tenant: mongoose.Types.ObjectId;
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
const OAUTH_CLIENT_ID = "e2e-tenants-client";
export const SHARED_KEY = "SAME";

export const ACME: TenantFixture = {
  slug: "acme",
  tenant: id("e2e0000000000000000ac000"),
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

export const GLOBEX: TenantFixture = {
  slug: "globex",
  tenant: id("e2e0000000000000000ab000"),
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

export const hostOf = (who: TenantFixture | string) =>
  `${typeof who === "string" ? who : who.slug}.${TENANT_DOMAIN}:${TENANTS_PORT}`;
export const originOf = (who: TenantFixture | string) => `http://${hostOf(who)}`;
export const PLATFORM_HOST = `${TENANT_DOMAIN}:${TENANTS_PORT}`;
// Node resolves *.localhost unevenly across platforms, so API calls go to the loopback address and
// name the tenant in Host; the browser resolves *.localhost itself
export const TENANTS_API = `http://127.0.0.1:${TENANTS_PORT}`;

export const asTenant = (who: TenantFixture, extra: Record<string, string> = {}) => ({
  host: hostOf(who),
  "sec-fetch-site": "same-origin",
  ...extra,
});

export const bearer = (who: TenantFixture) => ({ authorization: `Bearer ${who.apiToken}` });

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

export async function seedTwoTenants(): Promise<void> {
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
    await handle.collection("tenants").insertOne({ _id: who.tenant, name: who.projectName.split(" ")[0], slug: who.slug });
    await handle.collection("users").insertOne({
      _id: who.adminId,
      tenant: who.tenant,
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
      tenant: who.tenant,
      user: who.adminId,
      name: `${who.slug} token`,
      tokenHash: bcrypt.hashSync(who.apiToken, 4),
      prefix: who.apiToken.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    });
    await handle.collection("sessions").insertOne({
      tenant: who.tenant,
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
      tenant: who.tenant,
      name: `${who.slug}-machine`,
      owner: who.adminId,
    });
    await handle.collection("oauthtokens").insertOne({
      tenant: who.tenant,
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
      tenant: who.tenant,
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
      tenant: who.tenant,
      key: SHARED_KEY,
      name: who.projectName,
      taskCounter: 0,
    });
  }
  await mongoose.disconnect();
}

export async function signInOn(context: BrowserContext, who: TenantFixture): Promise<void> {
  await context.addCookies([
    {
      name: "__Host-bp_session",
      value: who.sessionToken,
      domain: `${who.slug}.${TENANT_DOMAIN}`,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

export const workerHeaders = (who: TenantFixture) => ({
  authorization: `Bearer ${WORKER_CREDENTIAL}`,
  "x-worker-id": String(who.workerId),
  "x-cp-protocol": "1",
});

export const oauthBearer = (who: TenantFixture) => ({ authorization: `Bearer ${who.oauthToken}` });

