import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { normaliseComposition } from "@/lib/agent-rules";
import { accessibleProjectIds, type IdentifiedSubject } from "@/lib/grants";

type Id = Types.ObjectId | string;

/**
 * What the account holds about one person (GDPR arts. 15 and 20), as JSON. Board content belongs to
 * the organisation, so it is here only where the person wrote it: their comments, the tasks they
 * created, the changes they made to tasks, their conversations with the PM agent and the personal
 * agents they composed, besides what the account holds about their own use of it: sessions and
 * consents. Never a password hash, a token's hash or a webhook address — a download is not a way to
 * carry a credential out.
 */
export async function accountExport(db: ScopedDb, user: IdentifiedSubject) {
  const userId = user._id as Id;
  const reach = await accessibleProjectIds(db, user);
  const mayRead = (project: unknown) => reach === null || reach.includes(String(project));
  const [record, grants, identities, apiTokens, tasks, comments, pmMessages, notifications, sessions, consents, activity, agents] =
    await Promise.all([
    db.User.findById(userId).lean(),
    db.Grant.find({ subject: userId }).lean(),
    db.Identity.find({ user: userId }).lean(),
    db.ApiToken.find({ user: userId }).select("name prefix createdAt lastUsedAt").lean(),
    db.Task.find({ createdBy: userId }).select("project taskNumber title description status createdAt").lean(),
    db.Comment.find({ author: userId }).select("task body createdAt").lean(),
    db.PmMessage.find({ triggeredBy: userId }).select("project role content createdAt").sort({ createdAt: 1 }).lean(),
    db.Notification.find({ recipient: userId }).select("type title body createdAt").sort({ createdAt: 1 }).lean(),
    db.Session.find({ user: userId }).select("userAgent ip createdAt lastUsedAt expiresAt").sort({ createdAt: 1 }).lean(),
    db.OAuthConsent.find({ user: userId }).select("clientId scope createdAt expiresAt").sort({ createdAt: 1 }).lean(),
    db.ActivityLog.find({ user: userId }).select("task action field oldValue newValue createdAt").sort({ createdAt: 1 }).lean(),
    db.Agent.find({ scope: "user", owner: userId }).select("name description composition createdAt").sort({ createdAt: 1 }).lean(),
  ]);

  const referencedTaskIds = [...comments.map((c) => c.task), ...activity.map((a) => a.task)] as Types.ObjectId[];
  const referencedTasks = referencedTaskIds.length
    ? await db.Task.find({ _id: { $in: referencedTaskIds } }).select("project taskNumber").lean()
    : [];
  const projectIds = [
    ...grants.map((g) => g.object),
    ...tasks.map((t) => t.project),
    ...referencedTasks.map((t) => t.project),
    ...pmMessages.map((m) => m.project),
  ] as Types.ObjectId[];
  const projects = projectIds.length
    ? await db.Project.find({ _id: { $in: projectIds } }).select("key name").lean()
    : [];
  const keyOf = new Map(projects.map((p) => [String(p._id), p.key]));
  const taskKey = (t: { project: unknown; taskNumber: number }) => `${keyOf.get(String(t.project)) ?? "?"}-${t.taskNumber}`;
  const referencedTaskKey = new Map(referencedTasks.map((t) => [String(t._id), taskKey(t)]));
  const referencedTaskProject = new Map(referencedTasks.map((t) => [String(t._id), t.project]));

  const chat = record?.notifications?.chat;
  return {
    exportedAt: new Date().toISOString(),
    account: record && {
      username: record.username,
      fullName: record.fullName,
      email: record.email,
      emailVerifiedAt: record.emailVerifiedAt,
      role: record.role,
      createdAt: record.createdAt,
      lastSignInAt: record.lastSignInAt,
      termsAcceptedVersion: record.termsAcceptedVersion,
      termsAcceptedAt: record.termsAcceptedAt,
      emailNotifications: record.emailNotifications,
      emailDigest: record.emailDigest,
      personalChat: chat?.kind || null,
    },
    boardAccess: grants.map((g) => ({
      board: keyOf.get(String(g.object)) ?? String(g.object),
      relation: g.relation,
      since: g.createdAt,
    })),
    signInProviders: identities.map((i) => ({
      provider: i.provider,
      email: i.email,
      linkedAt: (i as unknown as { linkedAt?: Date }).linkedAt,
      lastUsedAt: i.lastUsedAt,
    })),
    apiTokens: apiTokens.map((t) => ({ name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
    comments: comments.map((c) => ({
      task: referencedTaskKey.get(String(c.task)) ?? String(c.task),
      createdAt: c.createdAt,
      body: c.body,
    })),
    // A board the person no longer reaches shows them only that they made the task: what it says now
    // is other people's work, and an export is not a way back in
    tasksCreated: tasks.map((t) =>
      mayRead(t.project)
        ? { key: taskKey(t), title: t.title, description: t.description, status: t.status, createdAt: t.createdAt }
        : { key: taskKey(t), createdAt: t.createdAt }
    ),
    // On a board they no longer reach, only what they wrote: the replies summarise that board's work
    pmMessages: pmMessages
      .filter((m) => mayRead(m.project) || m.role === "user")
      .map((m) => ({
        board: keyOf.get(String(m.project)) ?? String(m.project),
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    notifications: notifications.map((n) => ({ type: n.type, title: n.title, body: n.body, createdAt: n.createdAt })),
    // What was changed is shown only on a board they still reach, for the reason the tasks above are
    activity: activity.map((a) => {
      const entry = {
        task: referencedTaskKey.get(String(a.task)) ?? String(a.task),
        action: a.action,
        field: a.field,
        createdAt: a.createdAt,
      };
      return mayRead(referencedTaskProject.get(String(a.task))) && referencedTaskProject.has(String(a.task))
        ? { ...entry, from: a.oldValue, to: a.newValue }
        : entry;
    }),
    sessions: sessions.map((x) => ({
      userAgent: x.userAgent,
      ip: x.ip,
      signedInAt: x.createdAt,
      lastUsedAt: x.lastUsedAt,
      expiresAt: x.expiresAt,
    })),
    consents: consents.map((x) => ({ client: x.clientId, scope: x.scope, grantedAt: x.createdAt, expiresAt: x.expiresAt })),
    personalAgents: agents.map((x) => ({
      name: x.name,
      description: x.description,
      createdAt: x.createdAt,
      steps: normaliseComposition(x.composition),
    })),
  };
}
