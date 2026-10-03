import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_ID, E2E_MONGODB_URI, MEMBER_ID, OWNER_ID, PROJECT_ID, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-841. Each administrator, or each board owner, removing the other at the same moment counted
 * the other as still there. Whichever way the two writes interleave, one of them must be refused.
 */

const ROUNDS = 12;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const write = (request: APIRequestContext, method: "put" | "delete", path: string, data?: unknown) =>
  request[method](path, { data, headers: { origin: new URL(test.info().project.use.baseURL!).origin } });

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("two administrators taking each other's role at once leave one", async ({ browser }) => {
  for (let round = 0; round < ROUNDS; round++) {
    // Fresh sessions each round: the deactivation that wins a round revokes the loser's
    await seed();
    await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { role: "admin" } });
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      await signIn(await a.newPage(), "admin");
      await signIn(await b.newPage(), "member");

      const answers = await Promise.all([
        write(a.request, "put", `/api/users/${MEMBER_ID}`, { role: "member" }),
        write(b.request, "put", `/api/users/${ADMIN_ID}`, { deactivate: true }),
      ]);
      // Through, or refused for this rule — both refused at once is the safe answer to a true race
      for (const answer of answers) expect([200, 409]).toContain(answer.status());

      const active = await (await db()).collection("users").countDocuments({ role: "admin", deactivatedAt: null });
      expect(active, `round ${round} left no active administrator`).toBeGreaterThanOrEqual(1);
    } finally {
      await a.close();
      await b.close();
    }
  }
});

test("two owners stepping down at once leave the board one", async ({ browser }) => {
  const owner = await browser.newContext();
  const admin = await browser.newContext();
  await signIn(await owner.newPage(), "owner");
  await signIn(await admin.newPage(), "admin");
  const grants = async () => (await db()).collection("grants");
  try {
    for (let round = 0; round < ROUNDS; round++) {
      await (await grants()).updateOne(
        { subject: MEMBER_ID, objectType: "project", object: PROJECT_ID },
        { $set: { relation: "owner" }, $setOnInsert: { createdBy: ADMIN_ID } },
        { upsert: true }
      );
      await (await grants()).updateOne(
        { subject: OWNER_ID, objectType: "project", object: PROJECT_ID },
        { $set: { relation: "owner" }, $setOnInsert: { createdBy: ADMIN_ID } },
        { upsert: true }
      );

      const answers = await Promise.all([
        write(owner.request, "put", `/api/projects/${PROJECT_ID}/members`, { userId: String(OWNER_ID), relation: "member" }),
        write(admin.request, "delete", `/api/projects/${PROJECT_ID}/members?userId=${MEMBER_ID}`),
      ]);
      for (const answer of answers) expect([200, 409]).toContain(answer.status());

      const owners = await (await grants()).countDocuments({ objectType: "project", object: PROJECT_ID, relation: "owner" });
      expect(owners, `round ${round} left the board no owner`).toBeGreaterThanOrEqual(1);
    }
  } finally {
    await owner.close();
    await admin.close();
  }
});
