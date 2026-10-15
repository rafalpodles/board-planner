import { percentile, WEEK_MS, type Spread } from "@/lib/insights";

export interface DoraDeployment {
  sha: string;
  state: "pending" | "success" | "failure" | "error";
  startedAt: Date;
  finishedAt: Date | null;
}

export interface DoraChange {
  url: string;
  headSha: string | null;
  mergedAt: Date;
}

export interface Dora {
  environment: string;
  deployments: number;
  weekly: { weekStart: string; successes: number; failures: number }[];
  deploymentsPerWeek: number | null;
  leadTimeForChanges: Spread | null;
  changeFailureRate: number | null;
  timeToRestore: Spread | null;
  unrestored: number;
  deploymentsWithoutChanges: number;
  syncedThrough: string | null;
  rateLimitedUntil: string | null;
}

function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: Math.round(percentile(sorted, 50)), p85Ms: Math.round(percentile(sorted, 85)) };
}

const failed = (d: DoraDeployment) => d.state === "failure" || d.state === "error";
const live = (d: DoraDeployment) => (d.finishedAt ?? d.startedAt).getTime();

/**
 * The four DORA figures for one environment over the last `weeks` weeks. They are conventions, and
 * these are the ones this product uses:
 *
 * - deployment frequency: successful deployments started in the window, per week;
 * - change failure rate: failed (failure or error) deployments over all that finished in the window;
 * - time to restore: from a failure to the next successful deployment, measured from the first
 *   failure of a run of them; a failure with no success after it yet is counted as unrestored;
 * - lead time for changes: a merged pull request's `mergedAt` to the moment the deployment that
 *   shipped it succeeded. That deployment is the first successful one of the pull request's head
 *   commit if there is one, and otherwise the first successful one that started at or after the
 *   merge — a squash or merge commit is never the head commit, so an exact match alone would leave
 *   most repositories without a figure. A change is counted in the window its deployment falls in.
 */
export function computeDora(
  allDeployments: DoraDeployment[],
  changes: DoraChange[],
  {
    now,
    weeks,
    environment,
    syncedThrough,
    rateLimitedUntil,
  }: { now: number; weeks: number; environment: string; syncedThrough: Date | null; rateLimitedUntil: Date | null }
): Dora {
  const from = now - weeks * WEEK_MS;
  const ordered = [...allDeployments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const inWindow = ordered.filter((d) => d.startedAt.getTime() >= from && d.startedAt.getTime() <= now);
  const finished = inWindow.filter((d) => d.state !== "pending");
  const successes = ordered.filter((d) => d.state === "success");

  const weekly = Array.from({ length: weeks }, (_, i) => ({
    weekStart: new Date(from + i * WEEK_MS).toISOString(),
    successes: 0,
    failures: 0,
  }));
  for (const d of finished) {
    const bucket = weekly[Math.min(weeks - 1, Math.floor((d.startedAt.getTime() - from) / WEEK_MS))];
    if (d.state === "success") bucket.successes++;
    else bucket.failures++;
  }
  const successCount = finished.filter((d) => d.state === "success").length;

  const restores: number[] = [];
  let unrestored = 0;
  for (const [i, d] of finished.entries()) {
    if (!failed(d) || (i > 0 && failed(finished[i - 1]))) continue;
    const next = successes.find((s) => s.startedAt.getTime() > d.startedAt.getTime());
    if (next) restores.push(Math.max(0, live(next) - live(d)));
    else unrestored++;
  }

  const shipped = new Set<DoraDeployment>();
  const leadTimes: number[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.url)) continue;
    seen.add(change.url);
    const merged = change.mergedAt.getTime();
    const deployment =
      (change.headSha && successes.find((s) => s.sha === change.headSha)) ||
      successes.find((s) => s.startedAt.getTime() >= merged);
    if (!deployment || live(deployment) < from || live(deployment) > now) continue;
    shipped.add(deployment);
    leadTimes.push(Math.max(0, live(deployment) - merged));
  }

  return {
    environment,
    deployments: finished.length,
    weekly,
    deploymentsPerWeek: finished.length ? Math.round((successCount / weeks) * 10) / 10 : null,
    leadTimeForChanges: spread(leadTimes),
    changeFailureRate: finished.length ? (finished.length - successCount) / finished.length : null,
    timeToRestore: spread(restores),
    unrestored,
    deploymentsWithoutChanges: finished.filter((d) => d.state === "success" && !shipped.has(d)).length,
    syncedThrough: syncedThrough ? syncedThrough.toISOString() : null,
    rateLimitedUntil: rateLimitedUntil && rateLimitedUntil.getTime() > now ? rateLimitedUntil.toISOString() : null,
  };
}
