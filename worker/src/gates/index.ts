import { WorkerConfig } from "../config.js";
import { Runner } from "../exec.js";
import { Gate } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { testRunGate } from "./test-run.js";
import { reviewGate } from "./review.js";

const TIMED_GATES = 3;
const GATE_TIMEOUT_CAP_MS = 600_000;

export function buildGates(config: WorkerConfig, runner: Runner): Gate[] {
  const gateTimeoutMs = Math.min(
    GATE_TIMEOUT_CAP_MS,
    Math.floor(config.taskTimeoutMs / TIMED_GATES)
  );

  return [
    diffSizeGate(config.maxDiffLines, config.maxDiffFiles),
    testPresenceGate(),
    buildGate(runner, gateTimeoutMs),
    testRunGate(runner, gateTimeoutMs),
    reviewGate(runner, gateTimeoutMs),
  ];
}
