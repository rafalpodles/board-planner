import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import FlakyReporter from "./flaky-reporter";

afterEach(() => vi.restoreAllMocks());

function testCase(id: string, file: string, ...titles: string[]): TestCase {
  return {
    id,
    expectedStatus: "passed",
    titlePath: () => ["", "board", file, ...titles],
  } as unknown as TestCase;
}

const ended = (status: TestResult["status"]) => ({ status }) as TestResult;

function run(
  secondPass: boolean,
  attempts: [TestCase, TestResult["status"][]][],
  firstPassFailed: string[] | null = null
) {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dir = mkdtempSync(join(tmpdir(), "flaky-"));
  const summaryFile = join(dir, "summary.md");
  const firstPassLastRun = join(dir, ".last-run.json");
  if (firstPassFailed) writeFileSync(firstPassLastRun, JSON.stringify({ status: "failed", failedTests: firstPassFailed }));
  const reporter = new FlakyReporter({ summaryFile, secondPass, firstPassLastRun });
  for (const [test, statuses] of attempts) for (const status of statuses) reporter.onTestEnd(test, ended(status));
  reporter.onEnd();
  const printed = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join("");
  return { summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : null, printed };
}

const avatar = testCase("a", "avatar-colours.spec.ts", "the colour follows the theme");
const steady = testCase("b", "steady.spec.ts", "always passes");
const broken = testCase("c", "broken.spec.ts", "always fails");

describe("the flake reporter", () => {
  it("lists a test that passed only on retry, and none that passed first time or never", () => {
    const { summary, printed } = run(false, [
      [avatar, ["failed", "passed"]],
      [steady, ["passed"]],
      [broken, ["failed", "failed"]],
    ]);

    expect(summary).toContain("| board | `avatar-colours.spec.ts` › the colour follows the theme | on retry |");
    expect(summary).not.toContain("steady.spec.ts");
    expect(summary).not.toContain("broken.spec.ts");
    expect(printed).toContain("::warning title=Flaky e2e test::avatar-colours.spec.ts › the colour follows the theme");
  });

  it("lists every test the first pass failed that passed on the second", () => {
    const { summary } = run(
      true,
      [
        [avatar, ["failed", "passed"]],
        [steady, ["passed"]],
        [broken, ["failed", "failed"]],
      ],
      ["a", "b", "c"]
    );

    expect(summary).toContain("`avatar-colours.spec.ts` › the colour follows the theme | on the second pass |");
    expect(summary).toContain("`steady.spec.ts` › always passes | on the second pass |");
    expect(summary).not.toContain("broken.spec.ts");
  });

  it("lists nothing for a second pass that ran the whole group because the first left no record", () => {
    const { summary } = run(true, [[steady, ["passed"]]]);

    expect(summary).toBeNull();
  });

  it("still lists a test that passed only on retry in a second pass, though the first pass never failed it", () => {
    const { summary } = run(true, [[avatar, ["failed", "passed"]], [steady, ["passed"]]], ["b"]);

    expect(summary).toContain("`avatar-colours.spec.ts` › the colour follows the theme | on retry |");
    expect(summary).toContain("`steady.spec.ts` › always passes | on the second pass |");
  });

  it("writes nothing when nothing flaked", () => {
    const { summary, printed } = run(false, [[steady, ["passed"]]]);

    expect(summary).toBeNull();
    expect(printed).toBe("");
  });

  it("keeps a title's pipe from breaking the table", () => {
    const piped = testCase("d", "pipes.spec.ts", "a | b");
    const { summary } = run(false, [[piped, ["timedOut", "passed"]]]);

    expect(summary).toContain("› a \\| b |");
  });

  it("keeps a title's line break from breaking the table", () => {
    const broken = testCase("e", "lines.spec.ts", "first\nsecond");
    const { summary } = run(false, [[broken, ["failed", "passed"]]]);

    expect(summary).toContain("› first second | on retry |");
  });

  it("is one of the suite's reporters", () => {
    expect(readFileSync(join(__dirname, "..", "playwright.config.ts"), "utf8")).toContain('["./e2e/flaky-reporter.ts"]');
  });
});
