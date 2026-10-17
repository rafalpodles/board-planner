import { CommandResult } from "../exec.js";
import { StreamEvent } from "../stream.js";
import { ResolvedTool } from "../tool-path.js";
import { RunOutcome } from "../types.js";

export type AgentId = "claude" | "codex";

export type Capability = "read-only" | "edit";

/**
 * What one run needs beyond its argv, made before the spawn and torn down after it. An agent whose
 * CLI keeps state in a home of its own (and needs a login copied into it) says so here, and the
 * worker confines the run to that directory as well as to the worktree.
 */
export interface AgentRun {
  /** Added to the allowlisted child environment */
  env: Record<string, string>;
  /** Directories the run may write beyond the worktree */
  writable: string[];
  /** Where this run keeps what it needs; the argv may name files in it */
  dir?: string;
  /** Removes whatever was made, credentials included; called once, whether the run ended well or not, and must not throw */
  cleanup(): Promise<void>;
}

export const NO_RUN: AgentRun = { env: {}, writable: [], cleanup: async () => {} };

export interface EditCall {
  prompt: string;
  systemPrompt: string;
  capability: Capability;
  model: string;
  fallbackModel: string;
  resultSchema: object;
  run: AgentRun;
}

export interface ReviewCall {
  prompt: string;
  systemPrompt: string;
  model: string;
  verdictSchema: object;
  run: AgentRun;
}

export interface Verdict {
  approved: boolean;
  reason: string;
}

/**
 * Everything the worker knows about one coding CLI. The executor and the review gate decide what to
 * ask and how to confine the process; an adapter says how that is spelt for its CLI and how its
 * output is read back, so a second CLI is a second adapter and not a second executor.
 */
export interface CodingAgent {
  readonly id: AgentId;
  readonly tool: Extract<ResolvedTool, "claude" | "codex">;
  readonly path: string;
  /**
   * Whether a step with this capability may write in the worktree. A CLI that has no tool list to
   * leave the write tools out of keeps a read-only step read-only by confinement alone.
   */
  worktreeWritable(capability: Capability): boolean;
  /** Whether the review gate's clean checkout is writable to the reviewer */
  readonly reviewerWritesCheckout: boolean;
  /** The per-run setup for a call whose answer must have this shape, or why this machine cannot make it */
  prepare(schema: object): Promise<AgentRun | { refusal: string }>;
  editArgs(call: EditCall): string[];
  reviewArgs(call: ReviewCall): string[];
  /** Whole lines of the CLI's live output, in the shape telemetry reads */
  parseEvents(text: string): StreamEvent[];
  /** A finished edit or read-only step, once the worker has ruled out a machine fault and a timeout */
  interpretEdit(result: CommandResult): RunOutcome;
  /** The reviewer's finished run, or null when what came back is not a verdict */
  parseVerdict(stdout: string): Verdict | null;
}
