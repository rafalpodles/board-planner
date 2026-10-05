import type mongoose from "mongoose";
import { decryptSecret, encryptSecret, isInstanceKeySecret } from "./encryption";

type Row = Record<string, unknown> & { _id: mongoose.Types.ObjectId; organisation?: mongoose.Types.ObjectId };

export interface ResealReport {
  resealed: number;
  byCollection: Record<string, number>;
  // Rows that changed while this ran, or whose secret no configured key opens: act on these
  needsAttention: string[];
}

// Every path a secret is stored at, as an array of steps; "*" walks an array
const PROJECT_SECRETS: string[][] = [
  ["githubToken"],
  ["gitlabToken"],
  ["codaToken"],
  ["notificationChannels", "*", "webhookUrl"],
  ["pm", "mcpServers", "*", "authToken"],
  ["pm", "mcpServers", "*", "oauth", "clientSecret"],
  ["pm", "mcpServers", "*", "oauth", "accessToken"],
  ["pm", "mcpServers", "*", "oauth", "refreshToken"],
];
const USER_SECRETS: string[][] = [["notifications", "chat", "webhookUrl"]];

function found(node: unknown, steps: string[], at: string[] = []): { path: string; value: string }[] {
  if (steps.length === 0) return typeof node === "string" ? [{ path: at.join("."), value: node }] : [];
  if (typeof node !== "object" || node === null) return [];
  const [step, ...rest] = steps;
  if (step === "*") {
    return Array.isArray(node) ? node.flatMap((item, index) => found(item, rest, [...at, String(index)])) : [];
  }
  return found((node as Record<string, unknown>)[step], rest, [...at, step]);
}

/**
 * BP-898: rewrites every secret still sealed under the instance key (v1, v2) under its
 * organisation's own data key (v3). Run after the release that reads v3, never before: the one
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
      const stale = paths.flatMap((steps) => found(row, steps)).filter(({ value }) => isInstanceKeySecret(value));
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
