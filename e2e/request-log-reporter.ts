import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * With E2E_REQUEST_LOG_DIR set, writes when each test ran and in which group, so e2e/route-groups.ts
 * can tell which test made each request e2e/request-log.cjs logged (BP-1081). The times come from
 * the worker, which started the test, not from when the runner heard about it: a `beforeAll`'s
 * first request can reach the server before the runner does.
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
    const start = result.startTime.getTime();
    const window = {
      start,
      end: start + result.duration,
      group: test.parent.project()?.name ?? "",
      spec: basename(test.location.file),
    };
    appendFileSync(this.file, `${JSON.stringify(window)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
