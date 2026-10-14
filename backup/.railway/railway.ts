import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "backup";

export default defineRailway(() => {
  const backup = service("backup", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: { cronSchedule: "7 * * * *", restartPolicyType: "NEVER" },
    env: {
      BACKUP_PASSPHRASE: preserve(),
      HEALTHCHECK_URL: preserve(),
      MONGODB_URI: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_BUCKET: preserve(),
      R2_ENDPOINT: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
    },
  });
  return project("board-planner", { resources: [backup] });
});
