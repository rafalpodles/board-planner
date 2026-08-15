import { Runner } from "../exec.js";
import { Gate, SnapshotEntry } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { protectedPathsGate } from "./protected-paths.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { testRunGate } from "./test-run.js";
import { reviewGate } from "./review.js";

const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_FILES = 10;

// A value this worker cannot read is the built-in default, never NaN and never zero — a threshold
// of zero refuses every change, which reads as a broken gate rather than a strict one.
function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// The block's key, not the kind: an agent may carry two gates of one kind with different limits,
// and the comment that refuses has to say which of them did.
function named(gate: Gate, name: string): Gate {
  return { name, run: gate.run };
}

/**
 * The gate a position in the sequence means, or null if this worker implements no such kind.
 *
 * Thresholds used to come off WorkerConfig, so every gate in a run shared one. They come off the
 * entry now, which is what makes two Size gates with different limits expressible at all.
 */
export function gateFromEntry(
  entry: SnapshotEntry,
  runner: Runner,
  timeoutMs: number,
  fallbackReviewModel: string
): Gate | null {
  const params = entry.params ?? {};

  switch (entry.gateKind) {
    case "diff-size":
      return named(
        diffSizeGate(
          numberOr(params.maxLines, DEFAULT_MAX_LINES),
          numberOr(params.maxFiles, DEFAULT_MAX_FILES)
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
        reviewGate(runner, timeoutMs, params.model || fallbackReviewModel, params.focus),
        entry.key
      );
    default:
      return null;
  }
}
