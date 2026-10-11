import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { accessibleProjectIds, type IdentifiedSubject } from "@/lib/grants";

type Id = Types.ObjectId | string;

/**
 * What the account holds about one person (GDPR arts. 15 and 20), as JSON. Board content belongs to
 * the organisation, so it is here only where the person wrote it: their comments, the tasks they
 * created and their conversations with the PM agent. Never a password hash, a token's hash or a
 * webhook address — a download is not a way to carry a credential out.
 */
export async function accountExport(db: ScopedDb, user: IdentifiedSubject) {
  const userId = user._id as Id;
  const reach = await accessibleProjectIds(db, user);
  const mayRead = (project: unknown) => reach === null || reach.includes(String(project));
  const [record, grants, identities, apiTokens, tasks, comments, pmMessages, notifications] = await Promise.all([
    db.User.findById(userId).lean(),
    db.Grant.find({ subject: userId }).lean(),
    db.Identity.find({ user: userId }).lean(),
    db.ApiToken.find({ user: userId }).select("name prefix createdAt lastUsedAt").lean(),
    db.Task.find({ createdBy: userId }).select("project taskNumber title description status createdAt").lean(),
    db.Comment.find({ author: userId }).select("task body createdAt").lean(),
    db.PmMessage.find({ triggeredBy: userId }).select("project role content createdAt").sort({ createdAt: 1 }).lean(),
    db.Notification.find({ recipient: userId }).select("type title body createdAt").sort({ createdAt: 1 }).lean(),
  ]);

  const commentTaskIds = comments.map((c) => c.task as Types.ObjectId);
  const commentTasks = commentTaskIds.length ? await db.Task.find({ _id: { $in: commentTaskIds } }).select("project taskNumber").lean() : [];
  const projectIds = [
    ...grants.map((g) => g.object),
    ...tasks.map((t) => t.project),
    ...commentTasks.map((t) => t.project),
    ...pmMessages.map((m) => m.project),
  ] as Types.ObjectId[];
  const projects = projectIds.length
    ? await db.Project.find({ _id: { $in: projectIds } }).select("key name").lean()
    : [];
  const keyOf = new Map(projects.map((p) => [String(p._id), p.key]));
  const taskKey = (t: { project: unknown; taskNumber: number }) => `${keyOf.get(String(t.project)) ?? "?"}-${t.taskNumber}`;
  const commentTaskKey = new Map(commentTasks.map((t) => [String(t._id), taskKey(t)]));

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
      task: commentTaskKey.get(String(c.task)) ?? String(c.task),
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
    pmMessages: pmMessages.map((m) => ({
      board: keyOf.get(String(m.project)) ?? String(m.project),
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    notifications: notifications.map((n) => ({ type: n.type, title: n.title, body: n.body, createdAt: n.createdAt })),
  };
}
