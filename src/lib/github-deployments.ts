import type { Types } from "mongoose";
import { decryptSecret } from "@/lib/encryption";
import {
  fetchDeployments,
  fetchDeploymentStatuses,
  GitHubRateLimited,
  parseRepoString,
  type GitHubDeploymentStatus,
} from "@/lib/github";
import { projectRepositoryUrl, repositoryProvider, type RepositoryFields } from "@/lib/repository";
import type { ScopedDb } from "@/lib/db-scope";
import { FINISHED_DEPLOYMENT_STATES, type DeploymentState } from "@/models/deployment";

export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "production";
export const DEPLOYMENT_PAGES_PER_TICK = 3;
export const STATUS_CHECKS_PER_TICK = 10;
/** A deployment that has reported no outcome for this long is not asked about again. */
export const PENDING_GIVE_UP_MS = 3 * 86_400_000;

export type DeploymentSyncProject = RepositoryFields & {
  _id: Types.ObjectId | string;
  githubToken?: string | null;
  deploymentEnvironment?: string | null;
  deploymentSync?: { syncedThrough?: Date | null; blockedUntil?: Date | null } | null;
};

export type DeploymentSyncResult =
  | { ran: true; requests: number; inserted: number; finished: number }
  | { ran: false; reason: "not github" | "rate limited"; requests: number };

export function outcomeOf(statuses: GitHubDeploymentStatus[]): { state: DeploymentState; at: Date; url: string } | null {
  const final = statuses.find((status) => (FINISHED_DEPLOYMENT_STATES as readonly string[]).includes(status.state));
  if (!final) return null;
  return {
    state: final.state as DeploymentState,
    at: new Date(final.created_at),
    url: final.environment_url || final.log_url || "",
  };
}

/**
 * One project's deployments to its production environment, read from GitHub into the store.
 *
 * The listing is newest first and is paged back only until it reaches the cursor, so a quiet
 * repository costs one request a tick; the first sync reads at most `DEPLOYMENT_PAGES_PER_TICK`
 * pages. A deployment's outcome arrives later than the deployment, so the unfinished ones are asked
 * about again, newest first, at most `STATUS_CHECKS_PER_TICK` a tick and never after
 * `PENDING_GIVE_UP_MS`. A rate limit stops the project's deployments until GitHub's reset.
 */
export async function syncGithubDeployments(
  db: ScopedDb,
  project: DeploymentSyncProject,
  now = new Date()
): Promise<DeploymentSyncResult> {
  const repositoryUrl = projectRepositoryUrl(project);
  const parsed = repositoryUrl && repositoryProvider(project) === "github" ? parseRepoString(repositoryUrl) : null;
  if (!parsed || !project.githubToken) return { ran: false, reason: "not github", requests: 0 };

  const blockedUntil = project.deploymentSync?.blockedUntil;
  if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
    return { ran: false, reason: "rate limited", requests: 0 };
  }

  const token = decryptSecret(project.githubToken, db.organisation);
  const environment = project.deploymentEnvironment || DEFAULT_DEPLOYMENT_ENVIRONMENT;
  const cursor = project.deploymentSync?.syncedThrough ?? null;
  let requests = 0;

  try {
    const listed = [];
    for (let page = 1; page <= DEPLOYMENT_PAGES_PER_TICK; page++) {
      requests++;
      const batch = await fetchDeployments(parsed.owner, parsed.repo, token, environment, page);
      listed.push(...batch);
      const reachedCursor = cursor !== null && batch.some((d) => new Date(d.created_at) < cursor);
      if (batch.length < 100 || reachedCursor) break;
    }

    const known = new Set(
      (
        await db.Deployment.find({ project: project._id, githubId: { $in: listed.map((d) => d.id) } }, "githubId").lean()
      ).map((d) => d.githubId)
    );
    const fresh = listed.filter((d) => !known.has(d.id));
    if (fresh.length > 0) {
      await db.Deployment.insertMany(
        fresh.map((d) => ({
          project: project._id,
          githubId: d.id,
          environment,
          sha: d.sha ?? "",
          ref: d.ref ?? "",
          state: "pending",
          startedAt: new Date(d.created_at),
        })),
        { ordered: false }
      ).catch((err: { code?: number; writeErrors?: unknown[] }) => {
        if (err?.code !== 11000 && !err?.writeErrors) throw err;
      });
    }

    const newest = listed.reduce<Date | null>((max, d) => {
      const at = new Date(d.created_at);
      return !max || at > max ? at : max;
    }, cursor);
    await db.Project.updateOne(
      { _id: project._id },
      { $set: { "deploymentSync.syncedThrough": newest, "deploymentSync.blockedUntil": null } }
    );

    const unfinished = await db.Deployment.find(
      { project: project._id, environment, state: "pending", startedAt: { $gte: new Date(now.getTime() - PENDING_GIVE_UP_MS) } },
      "githubId"
    )
      .sort({ startedAt: -1 })
      .limit(STATUS_CHECKS_PER_TICK)
      .lean();

    let finished = 0;
    for (const deployment of unfinished) {
      requests++;
      const outcome = outcomeOf(await fetchDeploymentStatuses(parsed.owner, parsed.repo, token, deployment.githubId));
      if (!outcome) continue;
      await db.Deployment.updateOne(
        { _id: deployment._id, state: "pending" },
        { $set: { state: outcome.state, finishedAt: outcome.at, url: outcome.url } }
      );
      finished++;
    }

    return { ran: true, requests, inserted: fresh.length, finished };
  } catch (err) {
    if (!(err instanceof GitHubRateLimited)) throw err;
    await db.Project.updateOne({ _id: project._id }, { $set: { "deploymentSync.blockedUntil": err.until } });
    return { ran: false, reason: "rate limited", requests };
  }
}
