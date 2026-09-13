import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNCONFINED_ACCEPTED_DETAIL, UNCONFINED_REASON } from "./sandbox.js";
import { UNCONFINED_ESCAPE_HATCH } from "./env.js";

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
const HEARTBEAT = join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "app",
  "api",
  "workers",
  "[workerId]",
  "heartbeat",
  "route.ts"
);

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

/**
 * BP-606 review. The server marks a passing check as "passed at a cost" from the `warn` flag the
 * worker sends — and a worker too old to send one reports the unconfined sandbox as a plain pass,
 * on a fleet that runs mixed versions as a matter of course because enrolling a machine is
 * self-service. So the route recognises that check by what its detail says as well, which puts a
 * copy of two of this package's strings on the other side of the boundary.
 */
describe("what the server reads an older worker's sandbox check by", () => {
  const route = () => readFileSync(HEARTBEAT, "utf8");

  it("names the escape hatch this worker actually reports", () => {
    expect(route()).toContain(UNCONFINED_ESCAPE_HATCH);
  });

  it("names the check whose detail carries it", () => {
    // `SANDBOX_CHECK` in preflight.ts, and the name the report is keyed by on both sides
    expect(route()).toContain('"sandbox"');
  });

  // The positive control: the two above are "this file contains that string" and would pass
  // against a route that had been renamed away or emptied.
  it("is reading the route that stores a preflight report", () => {
    expect(route()).toContain("function reportedPreflight");
  });
});
