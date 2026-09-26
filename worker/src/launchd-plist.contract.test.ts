import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBootstrap } from "./config.js";

const PLIST = join(import.meta.dirname, "..", "launchd", "com.boardplanner.worker.plist");
const README = join(import.meta.dirname, "..", "README.md");

const shipped = () => readFileSync(PLIST, "utf8");

function environmentOf(plist: string): Record<string, string> {
  const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    env[key] = value;
  }
  return env;
}

function placeholdersNamedInTheComment(plist: string): string[] {
  const comment = /<!--([\s\S]*?)-->/.exec(plist)?.[1] ?? "";
  return [...comment.matchAll(/^\s+([A-Z][A-Z_]+)\s{2,}\S/gm)].map((m) => m[1]).sort();
}

function placeholdersTheReadmeFills(): string[] {
  const readme = readFileSync(README, "utf8");
  const install = /```bash\n(sed [\s\S]*?launchd\/com\.boardplanner\.worker\.plist)/.exec(readme)?.[1] ?? "";
  return [...install.matchAll(/-e "s\|([A-Z][A-Z_]+)\|[^|]*\|g"/g)].map((m) => m[1]).sort();
}

function filledIn(plist: string, values: Record<string, string>): string {
  return placeholdersTheReadmeFills().reduce((text, name) => text.replaceAll(name, values[name] ?? ""), plist);
}

const MACHINE = {
  REPO_DIR: "/Users/op/board-planner",
  HOME_DIR: "/Users/op",
  BOARD_URL: "https://board.example.com",
  MACHINE_NAME: "op-mac",
};

describe("the launchd plist the worker ships with", () => {
  it("names in its comment every placeholder the README's install line fills, and no other", () => {
    expect(placeholdersNamedInTheComment(shipped())).toEqual(["BOARD_URL", "HOME_DIR", "MACHINE_NAME", "REPO_DIR"]);
    expect(placeholdersTheReadmeFills()).toEqual(placeholdersNamedInTheComment(shipped()));
  });

  it("filled in the README's way, starts a worker for that board under that name, with nothing left to fill", () => {
    const plist = filledIn(shipped(), MACHINE);
    const bootstrap = loadBootstrap(environmentOf(plist), () => "cpe_minted");

    for (const name of Object.keys(MACHINE)) expect(plist).not.toContain(name);
    expect(bootstrap.apiBaseUrl).toBe("https://board.example.com");
    expect(bootstrap.workerName).toBe("op-mac");
    expect(bootstrap.enrolmentTokenFile).toBe("/Users/op/.boardplanner/token");
    expect(bootstrap.enrolmentToken).toBe("cpe_minted");
    expect(bootstrap.stateDir).toBe("/Users/op/.boardplanner");
  });

  it("as shipped, refuses to start and names the address it still needs", () => {
    expect(() => loadBootstrap(environmentOf(shipped()), () => "")).toThrow(
      /CP_API_URL must be your board's address/
    );
  });

  it("points the worker at an enrolment token file and never at the retired API token", () => {
    const env = environmentOf(shipped());

    expect(env.CP_ENROLMENT_TOKEN_FILE).toBe("HOME_DIR/.boardplanner/token");
    expect(Object.keys(env).filter((key) => key.startsWith("CP_API_TOKEN"))).toEqual([]);
  });
});
