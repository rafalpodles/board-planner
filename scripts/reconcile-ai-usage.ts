/**
 * BP-647: does what the gateway recorded for one UTC day agree with what the provider reports for it?
 *
 * The gateway records what each response reported, so the two agree by construction, except for a call that was stopped (counted
 * at its prompt's estimate) and the edges of the day. This reads one completed UTC day of the operator's key (rows on the
 * operator's key only: an organisation's own key is its own account's) and OpenRouter's activity for the same day, model by
 * model, and exits 1 when they differ by more than the tolerance.
 *
 *   MONGODB_URI=... OPENROUTER_MANAGEMENT_KEY=... npx tsx scripts/reconcile-ai-usage.ts --date 2026-10-09
 *   ... --tolerance 0.02            # a share, default 0.02
 *   ... --api-key-hash <sha256>     # only the activity of that API key, which is the one the service runs on
 *
 * It needs a management key (OpenRouter's activity is refused to an ordinary key) and reads the database, so it runs from the
 * operator's own machine through the tunnel the other scripts here use (see cleanup-orphan-grants.ts).
 */
import mongoose from "mongoose";
import { resolveUri, dbName } from "./mongo-uri";
import { describeReconciliation, reconcile, utcDayRange, type ProviderActivity } from "../src/lib/ai-gateway/reconcile";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function providerActivity(date: string, apiKeyHash: string | undefined): Promise<ProviderActivity[]> {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) throw new Error("Set OPENROUTER_MANAGEMENT_KEY: OpenRouter's activity is for a management key, not an ordinary one");
  const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const query = new URLSearchParams({ date, ...(apiKeyHash ? { api_key_hash: apiKeyHash } : {}) });
  const response = await fetch(`${base}/activity?${query}`, { headers: { authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { data?: ProviderActivity[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter's answer has no data array");
  return body.data;
}

async function main() {
  const date = option("date");
  if (!date) throw new Error("Give the day: --date YYYY-MM-DD");
  const range = utcDayRange(date);
  if ("error" in range) throw new Error(range.error);
  const tolerance = Number(option("tolerance") ?? 0.02);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("--tolerance is a share, 0 or more");

  const { uri } = resolveUri();
  await mongoose.connect(uri, { autoIndex: false, ...(dbName() ? { dbName: dbName() } : {}) });
  try {
    const ours = await mongoose.connection
      .db!.collection("aiusages")
      .aggregate<{ _id: string; calls: number; promptTokens: number; completionTokens: number }>([
        { $match: { createdAt: { $gte: range.from, $lt: range.to }, keySource: { $in: ["managed", "instance"] } } },
        { $group: { _id: "$model", calls: { $sum: 1 }, promptTokens: { $sum: "$promptTokens" }, completionTokens: { $sum: "$completionTokens" } } },
      ])
      .toArray();
    const theirs = await providerActivity(date, option("api-key-hash"));

    const result = reconcile(
      ours.map((row) => ({ model: row._id, calls: row.calls, promptTokens: row.promptTokens, completionTokens: row.completionTokens })),
      theirs,
      tolerance
    );
    console.log(describeReconciliation(date, result, tolerance));
    process.exitCode = result.within ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
