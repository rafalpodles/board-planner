import { WorkerConfig } from "../config.js";
import { Runner } from "../exec.js";
import { Gate } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { protectedPathsGate } from "./protected-paths.js";
import { testRunGate } from "./test-run.js";
import { reviewGate } from "./review.js";

const TIMED_GATES = 3;
const GATE_TIMEOUT_CAP_MS = 600_000;

export function buildGates(config: WorkerConfig, runner: Runner): Gate[] {
  const gateTimeoutMs = Math.min(
    GATE_TIMEOUT_CAP_MS,
    Math.floor(config.taskTimeoutMs / TIMED_GATES)
  );

  // The static gates come first on purpose. Cost ordering would put build here, and build runs
  // npm on a tree the agent just wrote — executing its content before any gate has read it
  return [
    diffSizeGate(config.maxDiffLines, config.maxDiffFiles),
    protectedPathsGate(),
    testPresenceGate(),
    buildGate(runner, gateTimeoutMs),
    testRunGate(runner, gateTimeoutMs),
    // "Write code" trades the second model for speed: the static gates, the build and the tests
    // all still run, and the branch is still pushed and a pull request opened. Nothing merges
    // without it — applyPolicy refuses autoMerge while this is off, whatever the server said.
    // `!== false`, not truthiness: a config that never mentions the field — an older caller, a
    // partial patch — must still review. Only an explicit opt-out removes the second model.
    ...(config.reviewGate !== false ? [reviewGate(runner, gateTimeoutMs, config.reviewModel)] : []),
  ];
}
