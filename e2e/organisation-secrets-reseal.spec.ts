import { test, expect } from "@playwright/test";
import crypto from "crypto";
import mongoose from "mongoose";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI, e2eDatabaseName } from "./seed";

const DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_reseal_e2e`;
const ACME = new mongoose.Types.ObjectId("0000000000000000000000a1");
const PROJECT = new mongoose.Types.ObjectId("0000000000000000000a1001");
const USER = new mongoose.Types.ObjectId("0000000000000000000a1002");

// The v2 envelope the releases before BP-898 wrote: the instance key itself
function legacyV2(plaintext: string): string {
  const material = Buffer.from(E2E_ENCRYPTION_KEY, "hex");
  const id = crypto.createHash("sha256").update(material).digest("hex").slice(0, 8);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v2:${id}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

async function encryption() {
  process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
  return {
    ...(await import("../src/lib/encryption")),
    ...(await import("../src/lib/organisation-secrets-migration")),
  };
}

const col = (name: string) => mongoose.connection.db!.collection(name);

test.beforeEach(async () => {
  await mongoose.connect(E2E_MONGODB_URI, { dbName: DB, autoIndex: false, autoCreate: false });
  await mongoose.connection.dropDatabase();
  await col("projects").insertOne({
    _id: PROJECT,
    organisation: ACME,
    githubToken: legacyV2("ghp_acme"),
    notificationChannels: [{ _id: new mongoose.Types.ObjectId(), name: "Releases", webhookUrl: legacyV2("https://hooks.slack.com/x") }],
    pm: { mcpServers: [{ name: "tracker", authToken: legacyV2("mcp-token"), oauth: { clientSecret: "", accessToken: legacyV2("at"), refreshToken: "" } }] },
  } as never);
  await col("users").insertOne({ _id: USER, organisation: ACME, username: "boss", notifications: { chat: { kind: "slack", webhookUrl: legacyV2("https://hooks.slack.com/me") } } } as never);
});

test.afterEach(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("BP-898: the reseal moves every instance-key secret under its organisation's key, a dry run writes nothing, and a second run finds nothing", async () => {
  const { resealUnderOrganisationKeys, decryptSecret } = await encryption();

  const dry = await resealUnderOrganisationKeys(mongoose.connection, { apply: false });
  expect(dry.byCollection).toEqual({ projects: 4, users: 1 });
  expect((await col("projects").findOne({ _id: PROJECT }))!.githubToken).toMatch(/^enc:v2:/);

  const done = await resealUnderOrganisationKeys(mongoose.connection, { apply: true });
  expect(done.resealed).toBe(5);
  expect(done.needsAttention).toEqual([]);

  const project = (await col("projects").findOne({ _id: PROJECT }))!;
  const user = (await col("users").findOne({ _id: USER }))!;
  for (const value of [
    project.githubToken,
    project.notificationChannels[0].webhookUrl,
    project.pm.mcpServers[0].authToken,
    project.pm.mcpServers[0].oauth.accessToken,
    user.notifications.chat.webhookUrl,
  ]) {
    expect(value).toMatch(/^enc:v3:/);
  }
  expect(decryptSecret(project.githubToken, ACME)).toBe("ghp_acme");
  expect(decryptSecret(user.notifications.chat.webhookUrl, ACME)).toBe("https://hooks.slack.com/me");
  expect(() => decryptSecret(project.githubToken, new mongoose.Types.ObjectId("0000000000000000000000b2"))).toThrow(/another organisation/);
  expect(project.pm.mcpServers[0].oauth.refreshToken).toBe("");

  expect((await resealUnderOrganisationKeys(mongoose.connection, { apply: true })).resealed).toBe(0);
});
