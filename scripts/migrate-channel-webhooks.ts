/**
 * BP-372: encrypt the Slack/Discord webhook URL behind every project team channel.
 *
 * Usage:
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/migrate-channel-webhooks.ts --dry-run
 *   MONGODB_URI=... ENCRYPTION_KEY=... npx tsx scripts/migrate-channel-webhooks.ts
 *
 * Safe to re-run: a channel whose URL already carries an `enc:` envelope is left alone. The app
 * reads an unprefixed value as plaintext, so an unmigrated database keeps delivering and this is a
 * cleanup rather than a prerequisite — the deploy and this script can happen in either order.
 *
 * It does not un-leak anything. A URL that was stored in cleartext is in the oplog and in every
 * backup taken since, so rotating the webhook in Slack or Discord is the only thing that ends its
 * exposure; this stops the *current* document from carrying it.
 */

import mongoose from "mongoose";
import { encryptSecret, isEncryptedSecret, isEncryptionConfigured } from "../src/lib/encryption";
import { resolveUri, dbName } from "./mongo-uri";

const dryRun = process.argv.includes("--dry-run");

interface StoredChannel {
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
  const projectsTouched: string[] = [];

  for (const project of projects) {
    const name = project.key || String(project._id);
    const channels = project.notificationChannels || [];
    let changedHere = 0;

    const rewritten = channels.map((channel) => {
      const url = channel.webhookUrl;
      if (!url || isEncryptedSecret(url)) {
        if (url) alreadyEncrypted++;
        return channel;
      }
      changedHere++;
      console.log(`${name}: ${channel.name || "(unnamed)"}${dryRun ? " (dry run)" : ""}`);
      return { ...channel, webhookUrl: encryptSecret(url) };
    });

    if (changedHere === 0) continue;
    migrated += changedHere;
    projectsTouched.push(name);
    if (!dryRun) {
      await db
        .collection("projects")
        .updateOne({ _id: project._id }, { $set: { notificationChannels: rewritten } });
    }
  }

  console.log(
    `\n${dryRun ? "Would encrypt" : "Encrypted"} ${migrated} channel URL(s) across ` +
      `${projectsTouched.length} project(s); ${alreadyEncrypted} were already encrypted.`
  );
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
