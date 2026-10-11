import type { ScopedDb } from "@/lib/db-scope";
import { duplicateKeyField } from "@/lib/mongo-errors";

// Two first writes of one organisation's settings race on the unique index; the loser retries
export async function writeSettings(db: ScopedDb, update: Record<string, Record<string, unknown>>) {
  const write = () => db.Settings.findOneAndUpdate({}, update, { upsert: true });
  try {
    await write();
  } catch (err) {
    if (duplicateKeyField(err) !== "organisation") throw err;
    await write();
  }
}
