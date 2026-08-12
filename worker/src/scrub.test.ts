import { describe, it, expect } from "vitest";
import { scrub } from "./scrub.js";

// Shapes taken from what this system actually mints: src/app/api/tokens/route.ts:56 is
// `cp_` + 40 hex, src/lib/worker-service.ts:50 is `cpw_` + 64 hex.
const GITHUB_PAT = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
const WORKER_CREDENTIAL = `cpw_${"9f3c".repeat(16)}`;
const API_TOKEN = `cp_${"a1b2".repeat(10)}`;
const ANTHROPIC_KEY = "sk-ant-api03-7Vd2mQx_pLr8Kt3NwZa5Yb1Ce6Hg9Jk4Ml0Op2Qs";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3b3JrZXIifQ.7sVn-_1qO0aP";
const SESSION_TOKEN = `cps_${"7d1e".repeat(16)}`;

// randomToken() mints every one of these as its prefix plus 32 random bytes as hex
const PREFIXES = ["cp_", "cpw_", "cps_", "cpat_", "cprt_", "cpac_", "cpct_", "cpc_"];

interface Row {
  name: string;
  input: string;
  mustNotAppear: string[];
  mustAppear: string[];
}

const rows: Row[] = [
  {
    // gh auth login stores gho_, delivery.ts forwards GH_TOKEN into gh, and github_pat_ is a
    // different shape from ghp_ rather than a longer one
    name: "the GitHub token shapes that are not ghp_",
    input:
      "GH_TOKEN=gho_16C7e42F292c6912E7710c838347Ae178B4a rejected; also github_pat_11AABBCCD0aBcDeFgHiJk_LmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRs",
    mustNotAppear: ["gho_16C7e42F292c6912E7710c838347Ae178B4a", "github_pat_11AABBCCD0"],
    mustAppear: ["GH_TOKEN=[redacted]", "rejected"],
  },
  {
    // This system accepts Basic auth as well as Bearer, and base64 hides every other pattern here
    name: "an Authorization header echoed back by an HTTP error",
    input: "401 from /api/projects/CP/tasks/claim: Authorization: Basic cnBvOmNwX2ExYjJhMWIyYTFiMmExYjJhMWIyYTFiMmExYjJhMWIyYTFiMmExYjI=",
    mustNotAppear: ["cnBvOmNwX2Ex"],
    mustAppear: ["401 from /api/projects/CP/tasks/claim", "[redacted]"],
  },
  {
    name: "a lowercase bearer header, since HTTP is case-insensitive",
    input: "authorization: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3b3JrZXIifQ.7sVn-_1qO0aP",
    mustNotAppear: ["eyJhbGciOiJIUzI1NiJ9"],
    mustAppear: ["authorization: [redacted]"],
  },
  {
    // A credential in userinfo is caught by where it sits, not by matching a known token shape
    name: "a credential in a pull request url's userinfo",
    input: "Merged https://x-access-token:ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/rafalpodles/BoardPlanner/pull/7",
    mustNotAppear: ["x-access-token", "ghp_0123456789"],
    mustAppear: ["https://[redacted]@github.com/rafalpodles/BoardPlanner/pull/7", "Merged"],
  },
  {
    // The counterexample the no-\b decision turns on. Nothing pinned it before, so the tempting
    // one-character "fix" could be made without any test objecting.
    name: "kebab-case identifiers that merely look like key prefixes",
    input: "disk-ant-collector-metrics-service failed after risk-based routing in task-service",
    mustNotAppear: ["[redacted]"],
    mustAppear: ["disk-ant-collector-metrics-service", "risk-based", "task-service"],
  },
  {
    // ...and the glued secret the same decision protects, which \b would have missed
    name: "a credential glued straight to preceding word characters",
    input: `${"x".repeat(40)}cpw_9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c9f3c`,
    mustNotAppear: ["cpw_9f3c"],
    mustAppear: ["[redacted]"],
  },
  {
    name: "a session cookie in a Set-Cookie header, whose attributes stay readable",
    input: `< HTTP/1.1 200 OK\n< Set-Cookie: __Host-bp_session=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    mustNotAppear: [SESSION_TOKEN, "7d1e7d1e", "__Host-bp_session="],
    mustAppear: [
      "Set-Cookie: [redacted]; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000",
      "HTTP/1.1 200 OK",
    ],
  },
  {
    name: "a session cookie sent back in a Cookie header, alongside cookies that are not secrets",
    input: `> GET /api/auth/me\n> Cookie: theme=dark; __Host-bp_session=${SESSION_TOKEN}; sidebar=open\n< 401`,
    mustNotAppear: [SESSION_TOKEN, "__Host-bp_session="],
    mustAppear: ["Cookie: theme=dark; [redacted]; sidebar=open", "GET /api/auth/me", "< 401"],
  },
  {
    // COOKIE_ALLOW_INSECURE drops the prefix, and the value need not be a cps_ shape to be a session
    name: "an unprefixed session cookie whose value is not a recognisable token shape",
    input: "session rejected: Cookie: bp_session=Zm9vYmFy.trunc4ted; other=1",
    mustNotAppear: ["Zm9vYmFy", "bp_session="],
    mustAppear: ["session rejected: Cookie: [redacted]; other=1"],
  },
  {
    name: "a GitHub token embedded in a push failure",
    input: `could not push \`cp-161/worker\`: remote: Invalid username or password for https://x-access-token:${GITHUB_PAT}@github.com/rafalpodles/BoardPlanner.git`,
    mustNotAppear: [GITHUB_PAT, "0123456789abcdefghij"],
    mustAppear: [
      "remote: Invalid username or password",
      "github.com/rafalpodles/BoardPlanner.git",
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

  // Making the prefix group mandatory, or dropping its w branch, stops scrubbing cp_ and cpw_ —
  // the only two shapes the pattern caught before sessions and OAuth tokens were added to it
  it.each(PREFIXES)("redacts a %s credential", (prefix) => {
    const token = `${prefix}${"4e7a".repeat(16)}`;

    expect(scrub(`credential ${token} was rejected`)).toBe("credential [redacted] was rejected");
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

describe("scrub — every credential prefix this system mints", () => {
  const HEX = "a1b2".repeat(8);

  // cpe_ is the worker's own enrolment token, read off its own disk; cpd_ is a device code. Both
  // reach agent-authored summaries that get posted as board comments.
  const PREFIXES = ["cp_", "cpw_", "cps_", "cpe_", "cpd_", "cpat_", "cprt_", "cpac_", "cpct_", "cpc_"];

  for (const prefix of PREFIXES) {
    it(`redacts a bare ${prefix} token`, () => {
      const secret = `${prefix}${HEX}`;
      expect(scrub(`the token is ${secret} ok`)).not.toContain(secret);
    });
  }
});

// BP-306: what an agent with Read and HOME finds on a developer's disk, rather than what this
// codebase mints. Prefix coverage for our own tokens was already complete.
describe("credentials an agent reads off a disk", () => {
  it("redacts a PEM private key block, body and all", () => {
    const key = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const out = scrub(`found it:\n${key}\ndone`);

    expect(out).not.toContain("b3BlbnNzaC");
    expect(out).not.toContain("BEGIN OPENSSH");
    expect(out).toContain("done");
  });

  it("keeps two keys in one text apart rather than merging them", () => {
    const key = (body: string) =>
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;

    const out = scrub(`${key("AAAA")} between ${key("BBBB")}`);

    expect(out).toContain("between");
    expect(out).not.toContain("AAAA");
    expect(out).not.toContain("BBBB");
  });

  it.each([
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key"],
    ["ASIAIOSFODNN7EXAMPLE", "AWS session key"],
    // Assembled rather than written out: a literal here trips GitHub push protection, which
    // is the scanner agreeing that the pattern is right
    [["glpat", "ABCdef123456789_xyz1"].join("-"), "GitLab token"],
  ])("redacts %s (%s)", (secret) => {
    expect(scrub(`token=${secret} rest`)).not.toContain(secret);
  });

  // URL_USERINFO was anchored to https?://, so this walked straight through
  it("redacts userinfo on a scheme that is not http", () => {
    const out = scrub("MONGODB_URI=mongodb://admin:hunter2@cluster.example/db");

    expect(out).not.toContain("hunter2");
    expect(out).toContain("cluster.example");
  });

  it("leaves ordinary text alone", () => {
    const text = "see src/lib/task-service.ts and the AKIA-shaped column header";
    expect(scrub(text)).toBe(text);
  });
});
