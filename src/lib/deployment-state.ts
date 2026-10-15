export const FINISHED_DEPLOYMENT_STATES = ["success", "failure", "error"] as const;
export type DeploymentState = "pending" | (typeof FINISHED_DEPLOYMENT_STATES)[number];
