import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNCONFINED_ACCEPTED_DETAIL, UNCONFINED_REASON } from "./sandbox.js";

/**
 * BP-349 review. `e2e/worker-controls.spec.ts` drives the fleet screen by posting a heartbeat it
 * composes itself, so every string it asserts is one it wrote three lines earlier. That is the
 * right shape for a test about the *screen* — but it means the spec's copy of what a real machine
 * reports is maintained by hand, and cannot go red when the worker's copy changes.
 *
 * It already happened once: the commit that reordered `UNCONFINED_REASON` hand-edited the spec's
 * copy in the same breath, and nothing would have failed had it changed only one of them.
 *
 * Text rather than an import, in the worker's own suite rather than the app's: importing
 * `worker/src` into the Next app's type-check drags this package's `NodeJS.ProcessEnv` assumptions
 * into it — measured, `npx tsc --noEmit` then fails in `env.ts` on a `ProcessEnv` the app declares
 * differently. Same approach as server-values.contract.test.ts, for the same reason.
 */
const SPEC = join(import.meta.dirname, "..", "..", "e2e", "worker-controls.spec.ts");

describe("what the fleet screen shows about the sandbox", () => {
  const spec = () => readFileSync(SPEC, "utf8");

  it("asserts the refusal this worker actually reports", () => {
    expect(spec()).toContain(UNCONFINED_REASON);
  });

  it("asserts the accepted-risk detail this worker actually reports", () => {
    expect(spec()).toContain(UNCONFINED_ACCEPTED_DETAIL);
  });

  // The positive control for the two above, which are "this file contains that string" and would
  // pass vacuously against a spec that had been renamed away or emptied.
  it("is reading the spec that drives the fleet screen", () => {
    expect(spec()).toContain("the fleet screen says whether a machine confines the agent it runs");
  });
});
