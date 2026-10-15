import type { Types } from "mongoose";
import { decryptSecret } from "@/lib/encryption";
import {
  fetchDeployments,
  fetchDeploymentStatuses,
  GitHubRateLimited,
  GitHubRefused,
  parseRepoString,
  type GitHubDeploymentStatus,
} from "@/lib/github";
import { projectRepositoryUrl, repositoryProvider, type RepositoryFields } from "@/lib/repository";
import type { ScopedDb } from "@/lib/db-scope";
import { FINISHED_DEPLOYMENT_STATES, type DeploymentState } from "@/lib/deployment-state";

export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "production";
export const DEPLOYMENT_PAGES_PER_TICK = 3;
export const STATUS_CHECKS_PER_TICK = 10;
/** A deployment asked about at least once that has reported no outcome for this long is not asked about again. */
export const PENDING_GIVE_UP_MS = 3 * 86_400_000;
/** How long a listing GitHub refused for any reason but a rate limit waits before the tick asks again. */
export const REFUSED_RETRY_MS = 3_600_000;
/** A deployment whose statuses could not be read this many times is not asked about again. */
export const STATUS_FAILURE_LIMIT = 5;
const REFUSAL_STATUSES = [401, 403, 404];

export type DeploymentSyncProject = RepositoryFields & {
  _id: Types.ObjectId | string;
  githubToken?: string | null;
  deploymentEnvironment?: string | null;
  deploymentSync?: { syncedThrough?: Date | null; blockedUntil?: Date | null; lastError?: string | null } | null;
};

export type DeploymentSyncResult =
  | { ran: true; requests: number; inserted: number; finished: number }
  | { ran: false; reason: "not github" | "rate limited" | "refused"; requests: number };

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
 * about, newest first, at most `STATUS_CHECKS_PER_TICK` a tick. Every one is asked at least once,
 * so a first read's history fills in over the following ticks; one already asked is given up on
 * once it is `PENDING_GIVE_UP_MS` old. A rate limit stops the project's deployments until GitHub's
 * reset; any other refusal of the listing — typically a token without access to deployments — is
 * kept in `lastError` for the page to say, and the tick waits `REFUSED_RETRY_MS` before asking
 * again, though a person pressing Sync may ask at once.
 *
 * At most `DEPLOYMENT_PAGES_PER_TICK` pages are read in one go, so more than 300 deployments since
 * the cursor — a board coming back to Pro after months — leaves the older ones unread.
 *
 * The cursor is written only while the project still names the environment and repository this
 * pass read, so a pass that overlaps a change of either cannot put the old one's cursor back.
 */
export async function syncGithubDeployments(
  db: ScopedDb,
  project: DeploymentSyncProject,
  now = new Date(),
  { askedByPerson = false }: { askedByPerson?: boolean } = {}
): Promise<DeploymentSyncResult> {
  const repositoryUrl = projectRepositoryUrl(project);
  const parsed = repositoryUrl && repositoryProvider(project) === "github" ? parseRepoString(repositoryUrl) : null;
  if (!parsed || !project.githubToken) return { ran: false, reason: "not github", requests: 0 };

  const blockedUntil = project.deploymentSync?.blockedUntil;
  const refused = !!project.deploymentSync?.lastError;
  if (blockedUntil && blockedUntil.getTime() > now.getTime() && !(refused && askedByPerson)) {
    return { ran: false, reason: refused ? "refused" : "rate limited", requests: 0 };
  }
  const sameSource = {
    _id: project._id,
    deploymentEnvironment: project.deploymentEnvironment ?? null,
    repositoryUrl: project.repositoryUrl ?? null,
  };

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

    if (!(await db.Project.exists(sameSource))) return { ran: true, requests, inserted: 0, finished: 0 };

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
      ).catch((err: { code?: number; writeErrors?: { code?: number }[] }) => {
        const errors = err?.writeErrors?.length ? err.writeErrors : [err];
        if (!errors.every((e) => e?.code === 11000)) throw err;
      });
    }

    const newest = listed.reduce<Date | null>((max, d) => {
      const at = new Date(d.created_at);
      return !max || at > max ? at : max;
    }, cursor);
    await db.Project.updateOne(sameSource, {
      $set: { "deploymentSync.syncedThrough": newest, "deploymentSync.blockedUntil": null, "deploymentSync.lastError": "" },
    });

    const unfinished = await db.Deployment.find(
      {
        project: project._id,
        environment,
        state: "pending",
        failures: { $not: { $gte: STATUS_FAILURE_LIMIT } },
        $or: [{ answeredAt: null }, { startedAt: { $gte: new Date(now.getTime() - PENDING_GIVE_UP_MS) } }],
      },
      "githubId"
    )
      .sort({ lastCheckedAt: 1, startedAt: -1 })
      .limit(STATUS_CHECKS_PER_TICK)
      .lean();

    let finished = 0;
    for (const deployment of unfinished) {
      requests++;
      let statuses;
      try {
        statuses = await fetchDeploymentStatuses(parsed.owner, parsed.repo, token, deployment.githubId);
      } catch (err) {
        if (err instanceof GitHubRateLimited) throw err;
        console.warn(`GitHub deployment ${deployment.githubId} statuses could not be read: ${(err as Error).message}`);
        await db.Deployment.updateOne(
          { _id: deployment._id, state: "pending" },
          { $set: { lastCheckedAt: now }, $inc: { failures: 1 } }
        );
        continue;
      }
      const outcome = outcomeOf(statuses);
      await db.Deployment.updateOne(
        { _id: deployment._id, state: "pending" },
        {
          $set: outcome
            ? { state: outcome.state, finishedAt: outcome.at, url: outcome.url, lastCheckedAt: now, answeredAt: now }
            : { lastCheckedAt: now, answeredAt: now },
        }
      );
      if (outcome) finished++;
    }

    return { ran: true, requests, inserted: fresh.length, finished };
  } catch (err) {
    if (err instanceof GitHubRefused && REFUSAL_STATUSES.includes(err.status)) {
      await db.Project.updateOne(sameSource, {
        $set: {
          "deploymentSync.lastError": err.message,
          "deploymentSync.blockedUntil": new Date(now.getTime() + REFUSED_RETRY_MS),
        },
      });
      throw err;
    }
    if (!(err instanceof GitHubRateLimited)) throw err;
    await db.Project.updateOne(sameSource, { $set: { "deploymentSync.blockedUntil": err.until, "deploymentSync.lastError": "" } });
    return { ran: false, reason: "rate limited", requests };
  }
}
