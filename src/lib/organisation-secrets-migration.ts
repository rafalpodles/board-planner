import type mongoose from "mongoose";
import { SECRET_PATHS, secretsIn } from "./secret-paths";
import { decryptSecret, encryptSecret, isEncryptedSecret, isInstanceKeySecret } from "./encryption";

type Row = Record<string, unknown> & { _id: mongoose.Types.ObjectId; organisation?: mongoose.Types.ObjectId };

export interface ResealReport {
  resealed: number;
  byCollection: Record<string, number>;
  // Rows that changed while this ran, or whose secret no configured key opens: act on these
  needsAttention: string[];
}

const PROJECT_SECRETS = SECRET_PATHS.Project;
const USER_SECRETS = SECRET_PATHS.User;

function notUnderOrganisationKey(value: string): boolean {
  return value !== "" && (isInstanceKeySecret(value) || !isEncryptedSecret(value));
}

/**
 * BP-898: rewrites every secret still sealed under the instance key (v1, v2), or stored in the
 * clear by a release before encryption, under its organisation's own data key (v3). Run after the release that reads v3, never before: the one
 * before cannot open v3. Each row is rewritten only if every value this read is still there.
 */
export async function resealUnderOrganisationKeys(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<ResealReport> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const report: ResealReport = { resealed: 0, byCollection: {}, needsAttention: [] };

  for (const [collection, paths] of [
    ["projects", PROJECT_SECRETS],
    ["users", USER_SECRETS],
  ] as const) {
    report.byCollection[collection] = 0;
    for await (const row of db.collection<Row>(collection).find({})) {
      const stale = paths.flatMap((steps) => secretsIn(row, steps)).filter(({ value }) => notUnderOrganisationKey(value));
      if (stale.length === 0) continue;
      if (!row.organisation) {
        report.needsAttention.push(`${collection} ${row._id}: no organisation, so no key to seal under`);
        continue;
      }
      const set: Record<string, string> = {};
      try {
        for (const { path, value } of stale) set[path] = encryptSecret(decryptSecret(value, row.organisation), row.organisation);
      } catch (error) {
        report.needsAttention.push(`${collection} ${row._id}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (apply) {
        const unchanged = Object.fromEntries(stale.map(({ path, value }) => [path, value]));
        const written = await db.collection<Row>(collection).updateOne({ _id: row._id, ...unchanged }, { $set: set });
        if (written.modifiedCount === 0) {
          report.needsAttention.push(`${collection} ${row._id}: changed while this ran; run it again`);
          continue;
        }
      }
      report.byCollection[collection] += stale.length;
      report.resealed += stale.length;
    }
  }
  return report;
}
