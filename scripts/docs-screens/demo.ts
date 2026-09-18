/**
 * The demo instance the screenshots on board-planner.com/docs are taken from: Orbit Web App and
 * Atlas API, worked by Alex Rivera, Maya Chen and Sam Okafor. Refreshing them:
 *
 *   export MONGODB_URI=mongodb://localhost:27017/boardplanner_docs DEMO_PASSWORD=<anything>
 *   npx tsx scripts/docs-screens/demo.ts seed
 *   npx tsx scripts/docs-screens/ai-stub.ts &
 *   npm run build && OPENAI_API_KEY=stub OPENAI_BASE_URL=http://127.0.0.1:3616/v1 \
 *     OPENROUTER_API_KEY=stub OPENROUTER_BASE_URL=http://127.0.0.1:9 npm start
 *   npx tsx scripts/docs-screens/demo.ts ready
 *   BASE_URL=http://localhost:3000 OUT_DIR=../board-planner-site/public/screens \
 *     npx tsx scripts/docs-screens/capture.ts [name ...]
 *
 * A production build, because `next dev` paints its indicator over the account menu. The model
 * keys are stubs: the task form's AI Assist only shows with one set, and the PM agent's own must
 * lead nowhere so a scheduled review cannot spend money. `seed` moves every date in the data so its
 * "now" lands an hour ago — due dates stay due and "2h ago" stays true — and `ready` runs once the
 * app has started, because the agents it names are the ones the app seeds on boot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient, type Db, type Document } from "mongodb";
import { EJSON } from "bson";
import bcrypt from "bcryptjs";

interface DemoData {
  demoNow: Date;
  collections: Record<string, Document[]>;
}

// Like the e2e suite's `_e2e`: `seed` drops the database it is pointed at
const REQUIRED_SUFFIX = "_docs";
const PEOPLE = ["alex", "maya", "sam"];

function shiftDates(value: unknown, ms: number): unknown {
  if (value instanceof Date) return new Date(value.getTime() + ms);
  if (Array.isArray(value)) return value.map((item) => shiftDates(item, ms));
  if (value && typeof value === "object" && !("_bsontype" in value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftDates(item, ms)]));
  }
  return value;
}

function reviewSlotToday(timeZone: string, hour: number): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date()
  );
  return `${day}T${String(hour).padStart(2, "0")}`;
}

async function seed(db: Db): Promise<void> {
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error("Set DEMO_PASSWORD: every demo account signs in with it");

  const data = EJSON.parse(readFileSync(join(__dirname, "demo-data.json"), "utf8")) as DemoData;
  const shift = Math.round((Date.now() - 3_600_000 - data.demoNow.getTime()) / 60_000) * 60_000;

  await db.dropDatabase();
  for (const [name, docs] of Object.entries(data.collections)) {
    await db.collection(name).insertMany(docs.map((doc) => shiftDates(doc, shift) as Document));
  }

  const hash = await bcrypt.hash(password, 10);
  await db.collection("users").updateMany({ username: { $in: PEOPLE } }, { $set: { password: hash } });

  // Today's review has already happened, as far as the scheduler knows
  for (const project of await db.collection("projects").find({ "pm.autonomy.dailyReview": true }).toArray()) {
    const { timezone, reviewHour } = project.pm.autonomy;
    await db
      .collection("projects")
      .updateOne({ _id: project._id }, { $set: { "pm.autonomy.lastReviewSlot": reviewSlotToday(timezone, reviewHour) } });
  }

  console.log(`Seeded ${db.databaseName}, dates moved by ${(shift / 86_400_000).toFixed(1)} days`);
}

async function ready(db: Db): Promise<void> {
  const agent = await db.collection("agents").findOne({ name: "Default", scope: "global" });
  if (!agent) throw new Error("No global agent named Default yet: start the app once against this database first");
  await db.collection("projects").updateOne({ key: "ORB" }, { $set: { "worker.agent": agent._id } });

  // The demo machine has no process behind it, and goes stale five minutes after this
  const now = new Date();
  await db.collection("workers").updateMany({}, { $set: { lastSeenAt: now, "preflight.reportedAt": now } });
  console.log(`${db.databaseName} is ready to capture for the next five minutes`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "seed" && command !== "ready") throw new Error("Usage: demo.ts seed|ready");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI to the demo database");

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    if (!db.databaseName.endsWith(REQUIRED_SUFFIX)) {
      throw new Error(`Refusing ${db.databaseName}: the demo database's name must end in ${REQUIRED_SUFFIX}`);
    }
    await (command === "seed" ? seed(db) : ready(db));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
