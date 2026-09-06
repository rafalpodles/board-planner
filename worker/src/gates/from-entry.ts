import { Runner } from "../exec.js";
import { Gate, SnapshotEntry } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { protectedPathsGate } from "./protected-paths.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { testRunGate } from "./test-run.js";
import { reviewGate } from "./review.js";

export interface GateFallbacks {
  maxDiffLines: number;
  maxDiffFiles: number;
  reviewModel: string;
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function named(gate: Gate, name: string): Gate {
  return { name, run: gate.run };
}

export function gateFromEntry(
  entry: SnapshotEntry,
  runner: Runner,
  timeoutMs: number,
  fallbacks: GateFallbacks
): Gate | null {
  const params = entry.params ?? {};

  switch (entry.gateKind) {
    case "diff-size":
      return named(
        diffSizeGate(
          numberOr(params.maxLines, fallbacks.maxDiffLines),
          numberOr(params.maxFiles, fallbacks.maxDiffFiles)
        ),
        entry.key
      );
    case "protected-paths":
      return named(protectedPathsGate(), entry.key);
    case "test-presence":
      return named(testPresenceGate(), entry.key);
    case "build":
      return named(buildGate(runner, timeoutMs), entry.key);
    case "test-run":
      return named(testRunGate(runner, timeoutMs), entry.key);
    case "review":
      return named(
        reviewGate(runner, timeoutMs, params.model || fallbacks.reviewModel, params.focus),
        entry.key
      );
    default:
      return null;
  }
}
