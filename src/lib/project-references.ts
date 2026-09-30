import { Types } from "mongoose";
import { Agent } from "@/models/agent";
import { ApiToken } from "@/models/apiToken";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthToken } from "@/models/oauthToken";
import { PmOauthState } from "@/models/pmOauthState";
import { PmTrigger } from "@/models/pmTrigger";
import { User } from "@/models/user";
import { Worker } from "@/models/worker";

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

export async function dropProjectReferences(projectId: Types.ObjectId): Promise<void> {
  const pull = { $pull: { allowedProjects: projectId } };
  await ApiToken.deleteMany(scopedOnlyTo(projectId));
  await ApiToken.updateMany(scopedToItAndAnother(projectId), pull);
  await OAuthToken.deleteMany(scopedOnlyTo(projectId));
  await OAuthToken.updateMany(scopedToItAndAnother(projectId), pull);
  await OAuthCode.deleteMany(scopedOnlyTo(projectId));
  await OAuthCode.updateMany(scopedToItAndAnother(projectId), pull);

  await Worker.updateMany({ desiredProjects: projectId }, { $pull: { desiredProjects: projectId } });
  await User.updateMany(
    { "notifications.projects.project": projectId },
    { $pull: { "notifications.projects": { project: projectId } } }
  );
  await PmTrigger.deleteMany({ project: projectId });
  await PmOauthState.deleteMany({ project: projectId });
  await Agent.deleteMany({ scope: "project", project: projectId });
}
