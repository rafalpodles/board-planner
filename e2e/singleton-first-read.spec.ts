import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, seed } from "./seed";

// BP-722: simultaneous first reads of a singleton each inserted their own document

const CONCURRENT_READS = 30;
// Over HTTP the reads only sometimes land close enough to race; one round caught it about one time
// in six. Rounds make a regression fail the test rather than occasionally.
const ROUNDS = 20;

async function documentsIn(collection: string): Promise<number> {
  await mongoose.connect(E2E_MONGODB_URI);
  const count = await mongoose.connection.db!.collection(collection).countDocuments();
  await mongoose.disconnect();
  return count;
}

async function emptyCollection(collection: string) {
  await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection.db!.collection(collection).deleteMany({});
  await mongoose.disconnect();
}

async function readAtOnce(request: APIRequestContext, path: string) {
  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_READS }, () => request.get(path, { headers: ADMIN_AUTH }))
  );
  return responses.map((r) => r.status());
}

test.beforeEach(seed);

for (const [path, collection] of [
  ["/api/settings", "settings"],
  ["/api/entitlements", "tenants"],
] as const) {
  test(`simultaneous first reads of ${path} leave exactly one document`, async ({ request }) => {
    // Warm-up: otherwise the reads queue behind the route's first compile and never overlap
    expect((await request.get(path, { headers: ADMIN_AUTH })).status()).toBe(200);
    for (let round = 0; round < ROUNDS; round++) {
      await emptyCollection(collection);

      const statuses = await readAtOnce(request, path);

      expect(statuses, `round ${round}`).toEqual(Array(CONCURRENT_READS).fill(200));
      expect(await documentsIn(collection), `round ${round}`).toBe(1);
    }
  });
}
