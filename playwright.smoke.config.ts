import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export const SMOKES = {
  "mcp-stdio": "mcp-stdio.smoke.ts",
  worker: "worker.smoke.ts",
} as const;

export default defineConfig({
  ...base,
  projects: Object.entries(SMOKES).map(([name, file]) => ({
    name,
    use: { ...devices["Desktop Chrome"] },
    testMatch: `${__dirname}/e2e/smoke/${file}`,
  })),
});
