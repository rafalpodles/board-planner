/**
 * BP-372: encrypt the Slack/Discord webhook URL behind every project team channel.
 *
 * Usage:
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/migrate-channel-webhooks.ts --dry-run
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/migrate-channel-webhooks.ts
 *   railway run --service MongoDB -- npx tsx scripts/migrate-channel-webhooks.ts --dry-run
 *
 * RUN IT AFTER THE DEPLOY, never before. Reading plaintext exists only in the new code; the old
 * code hands the stored string straight to `isAllowedWebhookUrl`, which refuses an `enc:v2:…`
 * envelope for having no `https:` scheme — silently, and for every channel at once. An unmigrated
 * database on the new code keeps delivering, so the deploy does not wait for this. The reverse
 * is not true.
 *
 * Safe to re-run: a channel whose URL already carries an `enc:` envelope is left alone. Which is
 * also what it will not do — a value written by a key since retired to ENCRYPTION_KEYS_OLD stays
 * on that key. Re-keying is a separate job, and one every encrypted field in this product needs,
 * not only these.
 *
 * It does not un-leak anything. A URL that was stored in cleartext is in the oplog and in every
 * backup taken since, so rotating the webhook in Slack or Discord is the only thing that ends its
 * exposure; this stops the *current* document from carrying it.
 */

import mongoose from "mongoose";
import { encryptSecret, isEncryptedSecret, isEncryptionConfigured } from "../src/lib/encryption";
import { resolveUri, dbName } from "./mongo-uri";

const dryRun = process.argv.includes("--dry-run");

const label = (channel: { name?: string }) => channel.name || "(unnamed)";

interface StoredChannel {
  _id?: mongoose.Types.ObjectId;
  name?: string;
  webhookUrl?: string;
}

interface StoredProject {
  _id: mongoose.Types.ObjectId;
  key?: string;
  notificationChannels?: StoredChannel[];
}

async function main() {
  if (!isEncryptionConfigured()) {
    throw new Error("ENCRYPTION_KEY is required: this script writes with it, it does not read");
  }

  const { uri, source } = resolveUri();
  console.log(`Using ${source}`);
  await mongoose.connect(uri, { dbName: dbName() });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const projects = (await db
    .collection("projects")
    .find({ "notificationChannels.0": { $exists: true } })
    .toArray()) as unknown as StoredProject[];

  let migrated = 0;
  let alreadyEncrypted = 0;
  const projectsTouched = new Set<string>();
  const missed: string[] = [];

  for (const project of projects) {
    const name = project.key || String(project._id);

    for (const channel of project.notificationChannels || []) {
      const url = channel.webhookUrl;
      if (!url) {
        missed.push(`${name}: ${label(channel)} stores no URL`);
        continue;
      }
      if (isEncryptedSecret(url)) {
        alreadyEncrypted++;
        continue;
      }
      if (!channel._id) {
        missed.push(`${name}: ${label(channel)} has no _id, so it cannot be addressed`);
        continue;
      }

      console.log(`${name}: ${label(channel)}${dryRun ? " (dry run)" : ""}`);
      if (!dryRun) {
        // One channel at a time, addressed by its own _id. Rewriting the whole array from a
        // snapshot taken at startup would undo anything an operator changed while this ran —
        // including a webhook rotated in response to this script's own closing advice.
        const result = await db.collection("projects").updateOne(
          { _id: project._id },
          { $set: { "notificationChannels.$[c].webhookUrl": encryptSecret(url) } },
          { arrayFilters: [{ "c._id": channel._id, "c.webhookUrl": url }] }
        );
        if (result.modifiedCount === 0) {
          missed.push(`${name}: ${label(channel)} changed underneath this run — re-run to catch it`);
          continue;
        }
      }
      migrated++;
      projectsTouched.add(name);
    }
  }

  console.log(
    `\n${dryRun ? "Would encrypt" : "Encrypted"} ${migrated} channel URL(s) across ` +
      `${projectsTouched.size} project(s); ${alreadyEncrypted} were already encrypted.`
  );
  if (missed.length) {
    console.log(`\n${missed.length} channel(s) were left alone:`);
    for (const line of missed) console.log(`  ${line}`);
  }
  if (migrated > 0) {
    console.log("Rotate these webhooks in Slack or Discord: the old URLs are still in your backups.");
  }
  if (!dryRun) console.log("\nRe-run with --dry-run to confirm it reports nothing left to encrypt.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
