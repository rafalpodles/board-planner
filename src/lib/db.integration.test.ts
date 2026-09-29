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

describe.skipIf(!uri)("connectDB against a real mongod — a starved stale check", () => {
  let observer: MongoClient;
  let connectDB: Db["connectDB"];

  const connections = async (): Promise<number> =>
    (await observer.db("admin").command({ serverStatus: 1 })).connections.current;

  beforeAll(async () => {
    observer = await new MongoClient(uri!).connect();
  });

  afterAll(async () => {
    await observer?.close();
  });

  beforeEach(async () => {
    process.env.MONGODB_URI = uri;
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
    const running = settled(
      Thing.find({ $where: "sleep(1000) || true" })
        .sort({ n: 1 })
        .lean()
        .then((docs) => docs.map((doc) => doc.n))
    );

    await replaceUnderStarvation(connectDB);

    expect(await running).toEqual({ value: [1, 2, 3] });
  }, 30_000);

  it("lets a cursor read halfway through on the replaced client be read to the end", async () => {
    const cursor = Thing.find().sort({ n: 1 }).batchSize(1).lean().cursor();
    const first = await cursor.next();

    await replaceUnderStarvation(connectDB);

    const rest = await settled(
      (async () => {
        const seen: number[] = [];
        for (let doc = await cursor.next(); doc; doc = await cursor.next()) seen.push(doc.n);
        return seen;
      })()
    );
    expect(first?.n).toBe(1);
    expect(rest).toEqual({ value: [2, 3] });
  }, 30_000);

  it("closes the replaced client once its work is done, not before", async () => {
    const close = vi.spyOn(MongoClient.prototype, "close");
    const running = settled(Thing.find({ $where: "sleep(1000) || true" }).lean());

    const abandoned = await replaceUnderStarvation(connectDB);
    const closesOfAbandoned = () =>
      close.mock.contexts.filter((client) => client === abandoned).length;
    expect(closesOfAbandoned()).toBe(0);

    await running;
    await expect.poll(closesOfAbandoned, { timeout: 5_000 }).toBe(1);
    // And the replacement is the one answering
    await expect(Thing.countDocuments()).resolves.toBe(3);
  }, 30_000);

  // BP-520's leak, through this path: every replaced client has to be released, or the count
  // climbs by a client's worth of sockets per cycle
  it("does not leave connections behind across repeated replacements", async () => {
    const baseline = await connections();

    for (let cycle = 0; cycle < 6; cycle++) {
      const running = settled(Thing.find({ $where: "sleep(500) || true" }).lean());
      await replaceUnderStarvation(connectDB);
      expect(await running).toEqual({ value: expect.any(Array) });
    }

    await expect
      .poll(connections, { timeout: 10_000, interval: 500 })
      .toBeLessThanOrEqual(baseline + 2);
  }, 120_000);
});
