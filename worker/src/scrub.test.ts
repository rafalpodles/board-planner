import { describe, it, expect } from "vitest";
import { scrub } from "./scrub.js";

// Shapes taken from what this system actually mints: src/app/api/tokens/route.ts:56 is
// `cp_` + 40 hex, src/lib/worker-service.ts:50 is `cpw_` + 64 hex.
const GITHUB_PAT = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
const WORKER_CREDENTIAL = `cpw_${"9f3c".repeat(16)}`;
const API_TOKEN = `cp_${"a1b2".repeat(10)}`;
const ANTHROPIC_KEY = "sk-ant-api03-7Vd2mQx_pLr8Kt3NwZa5Yb1Ce6Hg9Jk4Ml0Op2Qs";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3b3JrZXIifQ.7sVn-_1qO0aP";

interface Row {
  name: string;
  input: string;
  mustNotAppear: string[];
  mustAppear: string[];
}

const rows: Row[] = [
  {
    name: "a GitHub token embedded in a push failure",
    input: `could not push \`cp-161/worker\`: remote: Invalid username or password for https://x-access-token:${GITHUB_PAT}@github.com/rafalpodles/ClaudePlanner.git`,
    mustNotAppear: [GITHUB_PAT, "0123456789abcdefghij"],
    mustAppear: [
      "remote: Invalid username or password",
      "github.com/rafalpodles/ClaudePlanner.git",
      "cp-161/worker",
      "[redacted]",
    ],
  },
  {
    name: "a worker credential in a registration error",
    input: `worker registration failed (401): worker w1 presented credential ${WORKER_CREDENTIAL}`,
    mustNotAppear: [WORKER_CREDENTIAL, "cpw_", "9f3c9f3c"],
    mustAppear: ["worker registration failed (401)", "worker w1 presented credential", "[redacted]"],
  },
  {
    name: "an api token in a config diagnostic",
    input: `config check failed: apiToken=${API_TOKEN} was rejected by /api/projects/CP/tasks/claim`,
    mustNotAppear: [API_TOKEN, "a1b2a1b2"],
    mustAppear: ["config check failed", "apiToken=[redacted]", "/api/projects/CP/tasks/claim"],
  },
  {
    name: "an anthropic key leaked through the environment",
    input: `the agent could not start: ANTHROPIC_API_KEY=${ANTHROPIC_KEY} is not valid for model claude-opus-5`,
    mustNotAppear: [ANTHROPIC_KEY, "api03-7Vd2mQx"],
    mustAppear: ["ANTHROPIC_API_KEY=[redacted]", "is not valid for model claude-opus-5"],
  },
  {
    name: "a bearer header in a request trace",
    input: `> POST /api/workers/w1/events\n> Authorization: ${BEARER}\n< 403 Forbidden`,
    mustNotAppear: [BEARER, "eyJhbGciOiJIUzI1NiJ9"],
    mustAppear: ["POST /api/workers/w1/events", "Authorization: [redacted]", "403 Forbidden"],
  },
  {
    name: "two different secrets on one line",
    input: `both credentials were rejected: ${GITHUB_PAT} and ${WORKER_CREDENTIAL}`,
    mustNotAppear: [GITHUB_PAT, WORKER_CREDENTIAL],
    mustAppear: ["both credentials were rejected: [redacted] and [redacted]"],
  },
  {
    name: "a secret mid-line leaves both halves of the line standing",
    input: `the build gate rejected the change: \`npm ci\` failed with GITHUB_TOKEN=${GITHUB_PAT} — 403 while fetching git+https://github.com/rafalpodles/private-dep.git`,
    mustNotAppear: [GITHUB_PAT],
    mustAppear: [
      "the build gate rejected the change",
      "GITHUB_TOKEN=[redacted]",
      "403 while fetching git+https://github.com/rafalpodles/private-dep.git",
    ],
  },
  {
    name: "a gate rejection whose words merely look like key prefixes",
    input: [
      "the test-run gate rejected the change: 3 of 412 tests failed.",
      "",
      "  FAIL src/lib/task-service.test.ts > risk-based routing > keeps disk-usage under the cap",
      "    expected ~120ms, got 8450ms on cp-161/worker against main",
      "    at Object.<anonymous> (src/lib/task-service.ts:88:11)",
    ].join("\n"),
    mustNotAppear: ["[redacted]"],
    mustAppear: [
      "task-service",
      "risk-based",
      "disk-usage",
      "~120ms",
      "cp-161/worker",
      "src/lib/task-service.ts:88:11",
    ],
  },
];

describe("scrub", () => {
  it.each(rows)("$name", ({ input, mustNotAppear, mustAppear }) => {
    const output = scrub(input);

    for (const secret of mustNotAppear) expect(output).not.toContain(secret);
    for (const kept of mustAppear) expect(output).toContain(kept);
  });

  it("leaves a realistic gate rejection byte-for-byte identical", () => {
    const rejection = [
      "the protected-paths gate rejected the change: 2 protected paths were touched.",
      "",
      "  .github/workflows/ci.yml",
      "  .husky/pre-commit",
      "",
      "Reviewed against base main; see risk-based-rollout.md and the disk-usage notes in",
      "src/lib/task-service.ts. Timings ranged ~40ms..~1_200ms.",
    ].join("\n");

    expect(scrub(rejection)).toBe(rejection);
  });

  it("redacts the match and not the line", () => {
    const output = scrub(
      `line one\nGITHUB_TOKEN=${GITHUB_PAT} is not authorized to push to refs/heads/main\nline three`
    );
    const lines = output.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("line one");
    expect(lines[1]).toBe("GITHUB_TOKEN=[redacted] is not authorized to push to refs/heads/main");
    expect(lines[2]).toBe("line three");
  });

  it("redacts every occurrence, not just the first", () => {
    const output = scrub(`a ${WORKER_CREDENTIAL} b ${WORKER_CREDENTIAL} c ${WORKER_CREDENTIAL} d`);

    expect(output).toBe("a [redacted] b [redacted] c [redacted] d");
  });

  it("returns the same result when called twice on the same text", () => {
    const input = `first ${GITHUB_PAT} second ${WORKER_CREDENTIAL}`;

    expect(scrub(input)).toBe(scrub(input));
  });

  it("is idempotent, so a redacted body can pass through a second time", () => {
    const once = scrub(`pushed with ${GITHUB_PAT}`);

    expect(scrub(once)).toBe(once);
  });

  it("leaves text with no secrets untouched", () => {
    expect(scrub("")).toBe("");
    expect(scrub("the diff-size gate rejected the change: 900 lines, limit is 400")).toBe(
      "the diff-size gate rejected the change: 900 lines, limit is 400"
    );
  });
});
