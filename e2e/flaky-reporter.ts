import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * BP-1086. CI retries a failed test once and then runs what still failed again on a fresh dev
 * server (BP-1042), so a test that fails and later passes leaves the job green. This names every
 * such test in the job's summary and as an annotation on the run, where it is seen.
 *
 * `E2E_SECOND_PASS=1` says this run is that second pass. A test the first pass failed, by the
 * `.last-run.json` CI keeps of it, that passes here is a flake too. Without that file
 * `--last-failed` runs the whole group, and none of it is a flake for having passed.
 */
export const SECOND_PASS_ENV = "E2E_SECOND_PASS";
export const FIRST_PASS_LAST_RUN = "e2e/.artifacts-first-pass/.last-run.json";

function failedInFirstPass(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  try {
    const { failedTests } = JSON.parse(readFileSync(file, "utf8")) as { failedTests?: unknown };
    return new Set(Array.isArray(failedTests) ? failedTests.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export interface Recovered {
  group: string;
  file: string;
  title: string;
  how: "on retry" | "on the second pass";
}

const escapeCell = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const escapeAnnotation = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function summaryOf(recovered: Recovered[]): string {
  return [
    "### Flaky end-to-end tests",
    "",
    "These failed and then passed, so the job stayed green. Each is a bug in the test or the app.",
    "",
    "| Group | Test | Passed |",
    "| --- | --- | --- |",
    ...recovered.map((r) => `| ${r.group} | \`${escapeCell(r.file)}\` › ${escapeCell(r.title)} | ${r.how} |`),
    "",
  ].join("\n");
}

export default class FlakyReporter implements Reporter {
  private readonly attempts = new Map<string, { test: TestCase; passed: boolean[]; skipped: boolean }>();
  private readonly summaryFile: string | undefined;
  private readonly firstPassFailed: Set<string>;

  constructor({
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
    secondPass = process.env[SECOND_PASS_ENV] === "1",
    firstPassLastRun = FIRST_PASS_LAST_RUN,
  }: { summaryFile?: string; secondPass?: boolean; firstPassLastRun?: string } = {}) {
    this.summaryFile = summaryFile;
    this.firstPassFailed = secondPass ? failedInFirstPass(firstPassLastRun) : new Set();
  }

  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const seen = this.attempts.get(test.id) ?? { test, passed: [], skipped: false };
    seen.passed.push(result.status === test.expectedStatus && result.status !== "skipped");
    seen.skipped = result.status === "skipped";
    this.attempts.set(test.id, seen);
  }

  recovered(): Recovered[] {
    const out: Recovered[] = [];
    for (const { test, passed, skipped } of this.attempts.values()) {
      if (skipped || !passed.at(-1)) continue;
      const retried = passed.slice(0, -1).some((ok) => !ok);
      const failedBefore = this.firstPassFailed.has(test.id);
      if (!retried && !failedBefore) continue;
      const [, group = "", file = "", ...titles] = test.titlePath();
      out.push({
        group,
        file,
        title: titles.join(" › "),
        how: failedBefore ? "on the second pass" : "on retry",
      });
    }
    return out;
  }

  onEnd(): void {
    const recovered = this.recovered();
    if (recovered.length === 0) return;
    for (const r of recovered) {
      process.stdout.write(
        `::warning title=Flaky e2e test::${escapeAnnotation(`${r.file} › ${r.title} failed, then passed ${r.how}`)}\n`
      );
    }
    if (this.summaryFile) appendFileSync(this.summaryFile, summaryOf(recovered));
  }
}
