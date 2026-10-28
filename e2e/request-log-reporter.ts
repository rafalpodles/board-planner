import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * With E2E_REQUEST_LOG_DIR set, writes when each test ran and in which group, so e2e/route-groups.ts
 * can tell which test made each request e2e/request-log.cjs logged (BP-1081). A test starts when
 * the worker says it did, which is before its `beforeAll`, and ends when the runner hears it has:
 * `result.duration` leaves `beforeAll` out. An `afterAll` runs after that, so the end of the run is
 * written too, and e2e/route-groups.ts stretches each test to the start of the next one.
 */
export default class RequestLogReporter implements Reporter {
  private readonly file: string | null;

  constructor({ dir = process.env.E2E_REQUEST_LOG_DIR }: { dir?: string } = {}) {
    if (!dir) {
      this.file = null;
      return;
    }
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `tests-${process.pid}-${Date.now()}.ndjson`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.file) return;
    const window = {
      start: result.startTime.getTime(),
      end: Date.now(),
      group: test.parent.project()?.name ?? "",
      spec: basename(test.location.file),
    };
    appendFileSync(this.file, `${JSON.stringify(window)}\n`);
  }

  onEnd(): void {
    if (!this.file) return;
    appendFileSync(this.file, `${JSON.stringify({ runEnd: Date.now() })}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
