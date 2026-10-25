import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { createNotifications } from "@/lib/in-app-notifications";
import { EXPIRY_WARNING_DAYS, formatDay } from "@/lib/connection-health";
import { forEachServedOrganisation } from "@/lib/organisation-jobs";
import type { SchedulerStart } from "@/lib/scheduler";

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

const PROVIDERS = [
  { name: "GitHub", field: "githubConnection", token: "githubToken" },
  { name: "GitLab", field: "gitlabConnection", token: "gitlabToken" },
] as const;

type Connection = { expiresAt?: Date | null; rejectedAt?: Date | null; expiryNotifiedFor?: Date | null };

/** Tells a board's owners, once per token, that its GitHub or GitLab token lapses within a week. */
export async function notifyExpiringTokens(db: ScopedDb, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS);
  let sent = 0;
  for (const provider of PROVIDERS) {
    const projects = await db.Project.find(
      {
        [provider.token]: { $nin: [null, ""] },
        [`${provider.field}.rejectedAt`]: null,
        [`${provider.field}.expiresAt`]: { $gt: now, $lte: horizon },
      },
      `key name ${provider.field}`
    ).lean();

    for (const project of projects) {
      const connection = (project as unknown as Record<string, Connection>)[provider.field];
      const expiresAt = connection?.expiresAt;
      if (!expiresAt) continue;
      // The claim is the expiry itself, so a token replaced by one with a later expiry is told again
      const claimed = await db.Project.updateOne(
        {
          _id: project._id,
          [`${provider.field}.expiresAt`]: expiresAt,
          [`${provider.field}.expiryNotifiedFor`]: { $ne: expiresAt },
        },
        { $set: { [`${provider.field}.expiryNotifiedFor`]: expiresAt } }
      );
      if (claimed.modifiedCount !== 1) continue;

      const owners = await livingOwners(db, String(project._id));
      if (owners.length === 0) continue;
      const day = formatDay(new Date(expiresAt));
      await createNotifications(db, {
        type: "token_expiring",
        projectId: String(project._id),
        recipientIds: owners,
        title: `The ${provider.name} token of ${project.name} expires on ${day}`,
        body: `Pull requests stop linking after that. Paste a new token in the board's settings before then.`,
        email: {
          kicker: "Token expiring",
          taskKey: project.key,
          taskTitle: project.name,
          taskMeta: `The ${provider.name} token expires on ${day}`,
          projectRef: project.key,
        },
      });
      sent += 1;
    }
  }
  return sent;
}

async function livingOwners(db: ScopedDb, projectId: string): Promise<string[]> {
  const grants = await db.Grant.find({ objectType: "project", relation: "owner", object: projectId }).select("subject").lean();
  const living = await db.User.find({ _id: { $in: grants.map((g) => g.subject) }, deactivatedAt: null }).select("_id").lean();
  return living.map((user) => String(user._id));
}

export async function tokenExpiryTick(now = new Date()): Promise<void> {
  await connectDB();
  await forEachServedOrganisation("Token expiry", (db) => notifyExpiringTokens(db, now).then(() => undefined));
}

let started = false;

export function startTokenExpiryScheduler(): SchedulerStart<"already running"> {
  if (started) return { started: false, reason: "already running" };
  started = true;
  setInterval(() => {
    tokenExpiryTick().catch((err) => console.error("Token expiry tick failed:", err));
  }, TICK_MS).unref();
  return { started: true, tickMs: TICK_MS };
}
