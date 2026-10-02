import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";
import { SMOKES } from "./e2e/smoke/smokes";

export default defineConfig({
  ...base,
  projects: Object.entries(SMOKES).map(([name, file]) => ({
    name,
    use: { ...devices["Desktop Chrome"] },
    testMatch: `${__dirname}/e2e/smoke/${file}`,
  })),
});
