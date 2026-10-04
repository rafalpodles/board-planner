import { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";

// An empty allowedProjects reads as unscoped (auth.ts), so a credential scoped to nothing but this
// project is revoked, and the id is pulled only from one that keeps another project afterwards.
export function scopedOnlyTo(projectId: Types.ObjectId) {
  return {
    $and: [
      { allowedProjects: projectId },
      { allowedProjects: { $not: { $elemMatch: { $ne: projectId } } } },
    ],
  };
}

export function scopedToItAndAnother(projectId: Types.ObjectId) {
  return {
    $and: [{ allowedProjects: projectId }, { allowedProjects: { $elemMatch: { $ne: projectId } } }],
  };
}

export async function dropProjectReferences(db: ScopedDb, projectId: Types.ObjectId): Promise<void> {
  const pull = { $pull: { allowedProjects: projectId } };
  await db.ApiToken.deleteMany(scopedOnlyTo(projectId));
  await db.ApiToken.updateMany(scopedToItAndAnother(projectId), pull);
  await db.OAuthToken.deleteMany(scopedOnlyTo(projectId));
  await db.OAuthToken.updateMany(scopedToItAndAnother(projectId), pull);
  await db.OAuthCode.deleteMany(scopedOnlyTo(projectId));
  await db.OAuthCode.updateMany(scopedToItAndAnother(projectId), pull);

  await db.Worker.updateMany({ desiredProjects: projectId }, { $pull: { desiredProjects: projectId } });
  await db.User.updateMany(
    { "notifications.projects.project": projectId },
    { $pull: { "notifications.projects": { project: projectId } } }
  );
  await db.PmTrigger.deleteMany({ project: projectId });
  await db.PmOauthState.deleteMany({ project: projectId });
  await db.Agent.deleteMany({ scope: "project", project: projectId });
}
