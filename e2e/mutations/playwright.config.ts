import path from "node:path";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import base from "../../playwright.config";

const ROOT = path.resolve(__dirname, "../..");
const HOLD = process.env.MUTATION_HOLD === "1";
const JSON_OUTPUT = process.env.MUTATION_JSON_OUTPUT;

type WebServer = NonNullable<Extract<PlaywrightTestConfig["webServer"], unknown[]>>[number];
const servers = (base.webServer as WebServer[]).map((server) => ({
  ...server,
  cwd: ROOT,
  reuseExistingServer: !HOLD,
}));

export default defineConfig({
  ...base,
  testDir: path.join(ROOT, "e2e"),
  outputDir: path.join(ROOT, "e2e/.artifacts"),
  globalTeardown: path.join(ROOT, "e2e/global-teardown.ts"),
  retries: 0,
  reporter: HOLD
    ? [["list"]]
    : [
        ["list"],
        [path.join(ROOT, "e2e/stub-crash-reporter.ts")],
        ...(JSON_OUTPUT ? [["json", { outputFile: JSON_OUTPUT }] as ["json", { outputFile: string }]] : []),
      ],
  ...(HOLD
    ? {
        timeout: 0,
        projects: [{ name: "hold", testDir: __dirname, testMatch: /hold-servers\.ts$/ }],
      }
    : {}),
  webServer: servers,
});
