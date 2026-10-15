import mongoose, { Schema, Model, Types } from "mongoose";
import { withOrganisation } from "@/lib/organisation-field";

import { FINISHED_DEPLOYMENT_STATES, type DeploymentState } from "@/lib/deployment-state";

export interface IDeployment {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  githubId: number;
  environment: string;
  sha: string;
  ref: string;
  state: DeploymentState;
  startedAt: Date;
  finishedAt: Date | null;
  url: string;
}

const deploymentSchema = new Schema<IDeployment>({
  project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  githubId: { type: Number, required: true },
  environment: { type: String, required: true },
  sha: { type: String, default: "" },
  ref: { type: String, default: "" },
  state: { type: String, enum: ["pending", ...FINISHED_DEPLOYMENT_STATES], default: "pending" },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  url: { type: String, default: "" },
});

deploymentSchema.index({ project: 1, githubId: 1, organisation: 1 }, { unique: true });
deploymentSchema.index({ project: 1, startedAt: -1 });
deploymentSchema.index({ project: 1, state: 1 });

withOrganisation(deploymentSchema);

export const Deployment: Model<IDeployment> =
  mongoose.models.Deployment || mongoose.model<IDeployment>("Deployment", deploymentSchema);
