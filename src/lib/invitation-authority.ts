import { Types } from "mongoose";
import { connectDB } from "./db";
import { Grant } from "@/models/grant";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { IInvitation, IInvitationBoard } from "@/types";

export interface AuthorityAtAcceptance {
  role: "admin" | "member";
  boards: IInvitationBoard[];
}

/**
 * What an invitation may still grant when it is spent, rather than what it said when it was sent:
 * an inviter demoted or deleted during the seven days does not get to grant through a link that
 * outlived their standing. Null means nothing it carries is still backed by anybody.
 */
export async function authorityAtAcceptance(
  invitation: Pick<IInvitation, "role" | "boards" | "invitedBy">
): Promise<AuthorityAtAcceptance | null> {
  await connectDB();
  const id = (v: Types.ObjectId | string) => String(v);
  const peopleIds = [invitation.invitedBy, ...invitation.boards.map((b) => b.addedBy)];
  const projectIds = invitation.boards.map((b) => b.project);

  const [people, projects, ownerships] = await Promise.all([
    User.find({ _id: { $in: peopleIds } }).select("role kind").lean(),
    Project.find({ _id: { $in: projectIds } }).select("_id").lean(),
    Grant.find({
      objectType: "project",
      relation: "owner",
      subject: { $in: peopleIds },
      object: { $in: projectIds },
    })
      .select("subject object")
      .lean(),
  ]);

  const admins = new Set(
    people.filter((p) => p.role === "admin" && p.kind !== "machine").map((p) => id(p._id))
  );
  const existing = new Set(projects.map((p) => id(p._id)));
  const owns = new Set(ownerships.map((g) => `${id(g.subject)}:${id(g.object)}`));

  const inviterIsAdmin = admins.has(id(invitation.invitedBy));
  if (invitation.role === "admin" && !inviterIsAdmin) return null;

  const boards = invitation.boards.filter(
    (b) =>
      existing.has(id(b.project)) &&
      (admins.has(id(b.addedBy)) || owns.has(`${id(b.addedBy)}:${id(b.project)}`))
  );
  if (!inviterIsAdmin && boards.length === 0) return null;

  return { role: invitation.role, boards };
}
