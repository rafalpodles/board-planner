import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CI = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const smokeJob = CI.slice(CI.indexOf("\n  smoke_worker:\n"), CI.indexOf("\n  smoke_licence:\n"));

describe("the worker smoke job", () => {
  // `next dev` compiles a route on its first request and answered the worker's first comment, status
  // and release calls with a bare 404 (BP-1050)
  it("runs the app as a production build", () => {
    const smokeStep = smokeJob.slice(smokeJob.indexOf("      - name: Smoke\n"), smokeJob.indexOf("      # The worker creates"));

    expect(smokeStep).toContain('E2E_PROD: "1"');
    expect(smokeStep).toContain("--project=worker");
  });

  // worker.lock is created write-only, so the archiver fails on it and a failed smoke leaves nothing (BP-1049)
  it("makes the artifacts readable before it uploads them, when it failed", () => {
    const chmod = smokeJob.indexOf("name: Make the artifacts readable");
    const upload = smokeJob.indexOf("actions/upload-artifact");

    expect(chmod).toBeGreaterThan(-1);
    expect(chmod).toBeLessThan(upload);
    expect(smokeJob.slice(chmod, upload)).toContain("if: failure()");
    expect(smokeJob.slice(chmod, upload)).toContain("chmod -R u+rX e2e/.artifacts");
  });
});
