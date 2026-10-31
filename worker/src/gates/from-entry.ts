import { Runner } from "../exec.js";
import { Gate, SnapshotEntry } from "../types.js";
import { diffSizeGate } from "./diff-size.js";
import { protectedPathsGate } from "./protected-paths.js";
import { testPresenceGate } from "./test-presence.js";
import { buildGate } from "./build.js";
import { testRunGate } from "./test-run.js";
import { reviewGate } from "./review.js";
import { codexAgent } from "../agents/codex.js";
import { GateCommands, NPM_GATES, usesOwnCommands } from "./gate-commands.js";

/**
 * What a block that names no parameter of its own falls back to: the project's own worker policy.
 *
 * Not the built-in constants. A project that pinned maxDiffLines to 2000 before the catalog existed
 * still has that setting stored, and dropping to 400 would refuse a 900-line change it used to
 * accept, with the setting that explains it no longer on the screen.
 */
export interface GateFallbacks {
  maxDiffLines: number;
  maxDiffFiles: number;
  reviewModel: string;
}

/** The absolute paths preflight resolved for what the gates spawn (BP-641, BP-733). */
export interface GateTools {
  git: string;
  npm: string;
  claude: string;
  /** Empty or absent on a machine without a signed-in Codex */
  codex?: string;
}

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

function refusingReview(reason: string, machineFault = true): Gate {
  // A machine fault: the machine cannot do this and no change was judged, so it must not read as the
  // reviewer rejecting one. A gate configured without what it needs is not the machine's fault, and
  // must not be handed back for another machine to try again for ever
  return { name: "review", run: async () => ({ ok: false, reason, ...(machineFault ? { machineFault: true } : {}) }) };
}

function reviewOn(
  params: Record<string, string>,
  runner: Runner,
  tools: GateTools,
  timeoutMs: number,
  fallbacks: GateFallbacks,
  sealHome: boolean
): Gate {
  const provider = typeof params.provider === "string" && params.provider ? params.provider : "claude";
  const model = typeof params.model === "string" ? params.model.trim() : "";
  if (provider === "claude") {
    return reviewGate(runner, tools.git, tools.claude, timeoutMs, params.model || fallbacks.reviewModel, params.focus, sealHome);
  }
  if (provider !== "codex") return refusingReview(`this worker does not know the reviewer ${provider}`);
  if (!tools.codex) return refusingReview("this review runs on Codex, which this machine cannot run");
  if (!model) return refusingReview("this review runs on Codex and names no model", false);
  return reviewGate(runner, tools.git, codexAgent(tools.codex), timeoutMs, model, params.focus, sealHome);
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
  tools: GateTools,
  timeoutMs: number,
  fallbacks: GateFallbacks,
  commands: GateCommands = NPM_GATES
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
      return named(protectedPathsGate(commands), entry.key);
    case "test-presence":
      return named(testPresenceGate(commands), entry.key);
    case "build":
      return named(buildGate(runner, tools.npm, timeoutMs, commands), entry.key);
    case "test-run":
      return named(testRunGate(runner, tools.npm, timeoutMs, commands), entry.key);
    case "review":
      return named(reviewOn(params, runner, tools, timeoutMs, fallbacks, usesOwnCommands(commands)), entry.key);
    default:
      return null;
  }
}
