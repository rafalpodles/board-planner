import { InvitationBoardInput } from "@/lib/invitations";
import { ApiInvitation, IInvitation } from "@/types";
import type { ScopedDb } from "@/lib/db-scope";

type Viewable = Pick<
  IInvitation,
  "_id" | "email" | "role" | "boards" | "invitedBy" | "expiresAt" | "createdAt"
>;

export async function toApiInvitations(db: ScopedDb, invitations: Viewable[]): Promise<ApiInvitation[]> {
  const projectIds = invitations.flatMap((i) => i.boards.map((b) => b.project));
  const inviterIds = invitations.map((i) => i.invitedBy);
  const [projects, inviters] = await Promise.all([
    db.Project.find({ _id: { $in: projectIds } }).select("key name").lean(),
    db.User.find({ _id: { $in: inviterIds } }).select("username fullName").lean(),
  ]);
  const projectById = new Map(projects.map((p) => [String(p._id), p]));
  const inviterById = new Map(inviters.map((u) => [String(u._id), u]));
  const now = Date.now();

  return invitations.map((i) => {
    const inviter = inviterById.get(String(i.invitedBy));
    return {
      _id: String(i._id),
      email: i.email,
      role: i.role,
      boards: i.boards.flatMap((b) => {
        const project = projectById.get(String(b.project));
        return project
          ? [{ project: String(project._id), key: project.key, name: project.name, relation: b.relation }]
          : [];
      }),
      invitedBy: inviter
        ? { _id: String(inviter._id), username: inviter.username, fullName: inviter.fullName }
        : null,
      expiresAt: new Date(i.expiresAt).toISOString(),
      expired: new Date(i.expiresAt).getTime() <= now,
      createdAt: new Date(i.createdAt).toISOString(),
    };
  });
}

export function describeInvitation(
  role: "admin" | "member",
  boards: InvitationBoardInput[],
  projects: { _id: unknown; key: string }[],
  delivery: "email" | "link"
): string {
  const keyOf = new Map(projects.map((p) => [String(p._id), p.key]));
  const onBoards = boards.length
    ? boards.map((b) => `${keyOf.get(String(b.project)) ?? "?"} (${b.relation})`).join(", ")
    : "no boards";
  const as = role === "admin" ? "an administrator" : "a member";
  return `as ${as}, ${onBoards}, ${delivery === "email" ? "by email" : "as a link"}`;
}
