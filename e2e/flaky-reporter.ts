import { appendFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * BP-1086. CI retries a failed test once and then runs what still failed again on a fresh dev
 * server (BP-1042), so a test that fails and later passes leaves the job green. This names every
 * such test in the job's summary and as an annotation on the run, where it is seen.
 *
 * `E2E_SECOND_PASS=1` says this run is that second pass: it runs only tests the first pass
 * failed, so every one of them that passes here is a flake too.
 */
export const SECOND_PASS_ENV = "E2E_SECOND_PASS";

export interface Recovered {
  group: string;
  file: string;
  title: string;
  how: "on retry" | "on the second pass";
}

const escapeCell = (text: string) => text.replace(/\|/g, "\\|");
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
  private readonly secondPass: boolean;

  constructor({
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
    secondPass = process.env[SECOND_PASS_ENV] === "1",
  }: { summaryFile?: string; secondPass?: boolean } = {}) {
    this.summaryFile = summaryFile;
    this.secondPass = secondPass;
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
      if (!retried && !this.secondPass) continue;
      const [, group = "", file = "", ...titles] = test.titlePath();
      out.push({
        group,
        file,
        title: titles.join(" › "),
        how: this.secondPass ? "on the second pass" : "on retry",
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
