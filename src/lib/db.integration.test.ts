import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";

// Runs against a real mongod, which the unit job does not have:
// MONGODB_INTEGRATION_URI=mongodb://127.0.0.1:27017/db_integration npx vitest run src/lib/db.integration.test.ts
const uri = process.env.MONGODB_INTEGRATION_URI;

type Db = typeof import("./db");

const Thing =
  mongoose.models.DbIntegrationThing ??
  mongoose.model("DbIntegrationThing", new mongoose.Schema({ n: Number }), "db_integration_things");

// What mongoose itself does to readyState after a frozen process: no heartbeat seen in 2 x
// heartbeatFrequencyMS reads as disconnected, whatever the server is doing.
function heartbeatWentStale() {
  (mongoose.connection as unknown as { _lastHeartbeatAt: number })._lastHeartbeatAt =
    Date.now() - 60_000;
}

// Longer than STALE_CHECK_TIMEOUT_MS, and synchronous: the ping cannot be answered while it runs,
// which is what a PM turn or a loaded machine does to the confirmation ping.
function starveEventLoop(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // spin
      }
      resolve();
    })
  );
}

async function replaceUnderStarvation(connectDB: Db["connectDB"]) {
  const before = mongoose.connection.getClient();
  heartbeatWentStale();
  const reconnect = connectDB();
  await starveEventLoop(2_500);
  await reconnect;
  const after = mongoose.connection.getClient();
  expect(after).not.toBe(before);
  return before;
}

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error: `${error.name}: ${error.message}` })
  );

const APP_NAME = "db-integration-test";
const appUri = uri && `${uri}${uri.includes("?") ? "&" : "?"}appName=${APP_NAME}`;

describe.skipIf(!uri)("connectDB against a real mongod — a starved stale check", () => {
  let observer: MongoClient;
  let connectDB: Db["connectDB"];

  // Scoped to this file's own clients by appName, so other users of the server do not count
  const currentOps = async (match: Record<string, unknown>) =>
    observer
      .db("admin")
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: true } },
        { $match: { appName: APP_NAME, ...match } },
      ])
      .toArray();
  const connections = async (): Promise<number> => (await currentOps({})).length;
  const findStillRunning = async (): Promise<boolean> =>
    (await currentOps({ active: true, "command.find": "db_integration_things" })).length > 0;

  const halfReadCursor = async () => {
    const cursor = Thing.find().sort({ n: 1 }).batchSize(1).lean().cursor();
    const first = await cursor.next();
    expect(first?.n).toBe(1);
    return async () => {
      const seen: number[] = [];
      for (let doc = await cursor.next(); doc; doc = await cursor.next()) seen.push(doc.n);
      return seen;
    };
  };

  beforeAll(async () => {
    observer = await new MongoClient(uri!).connect();
  });

  afterAll(async () => {
    await observer?.close();
  });

  beforeEach(async () => {
    process.env.MONGODB_URI = appUri;
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
    vi.resetModules();
    ({ connectDB } = await import("./db"));
    await connectDB();
    await Thing.deleteMany({});
    await Thing.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mongoose.disconnect();
    delete (globalThis as { mongooseCache?: unknown }).mongooseCache;
  });

  // The control: unstarved, the ping answers and the live client is kept, so the tests below are
  // about the starvation and not a stale check that always resets
  it("keeps the client when the confirmation ping gets to answer", async () => {
    const before = mongoose.connection.getClient();
    heartbeatWentStale();

    await connectDB();

    expect(mongoose.connection.getClient()).toBe(before);
  });

  it("lets a query already running on the replaced client finish", async () => {
    // 3 x 2.5 s on the server against a 2.5 s spin, and checked below rather than assumed
    const running = settled(
      Thing.find({ $where: "sleep(2500) || true" })
        .sort({ n: 1 })
        .lean()
        .then((docs) => docs.map((doc) => doc.n))
    );

    await replaceUnderStarvation(connectDB);
    expect(await findStillRunning()).toBe(true);

    expect(await running).toEqual({ value: [1, 2, 3] });
  }, 30_000);

  it("lets a cursor read halfway through on the replaced client be read to the end", async () => {
    const readRest = await halfReadCursor();

    await replaceUnderStarvation(connectDB);

    expect(await settled(readRest())).toEqual({ value: [2, 3] });
  }, 30_000);

  // Held open by the test itself, so how fast the machine is decides nothing
  it("closes the replaced client once its work is done, not before", async () => {
    const close = vi.spyOn(MongoClient.prototype, "close");
    const readRest = await halfReadCursor();

    const abandoned = await replaceUnderStarvation(connectDB);
    const closesOfAbandoned = () =>
      close.mock.contexts.filter((client) => client === abandoned).length;
    expect(closesOfAbandoned()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(closesOfAbandoned()).toBe(0);

    expect(await readRest()).toEqual([2, 3]);
    await expect.poll(closesOfAbandoned, { timeout: 5_000 }).toBe(1);
    await expect(Thing.countDocuments()).resolves.toBe(3);
  }, 30_000);

  // BP-520's leak, through the drain path: each cycle leaves work on the client it replaces, and
  // every one of those clients has to be released once that work is done
  it("does not leave connections behind across repeated replacements", async () => {
    const close = vi.spyOn(MongoClient.prototype, "close");
    const baseline = await connections();
    expect(baseline).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 6; cycle++) {
      const readRest = await halfReadCursor();
      const abandoned = await replaceUnderStarvation(connectDB);
      const closesOfAbandoned = () =>
        close.mock.contexts.filter((client) => client === abandoned).length;
      expect(closesOfAbandoned()).toBe(0);

      expect(await readRest()).toEqual([2, 3]);
      await expect.poll(closesOfAbandoned, { timeout: 5_000 }).toBe(1);
    }

    await expect
      .poll(connections, { timeout: 10_000, interval: 500 })
      .toBeLessThanOrEqual(baseline + 2);
  }, 120_000);
});
