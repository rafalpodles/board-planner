import { CommandResult } from "../exec.js";
import { StreamEvent } from "../stream.js";
import { ResolvedTool } from "../tool-path.js";
import { RunOutcome } from "../types.js";

export type AgentId = "claude";

export type Capability = "read-only" | "edit";

export interface EditCall {
  prompt: string;
  systemPrompt: string;
  capability: Capability;
  model: string;
  fallbackModel: string;
  resultSchema: object;
}

export interface ReviewCall {
  prompt: string;
  systemPrompt: string;
  model: string;
  verdictSchema: object;
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
  /** Which resolved tool this is; an agent can name only a coding CLI, never git, gh or npm */
  readonly tool: Extract<ResolvedTool, "claude">;
  readonly path: string;
  editArgs(call: EditCall): string[];
  reviewArgs(call: ReviewCall): string[];
  /** Whole lines of the CLI's live output, in the shape telemetry reads */
  parseEvents(text: string): StreamEvent[];
  /** A finished edit or read-only step, once the worker has ruled out a machine fault and a timeout */
  interpretEdit(result: CommandResult): RunOutcome;
  /** The reviewer's finished run, or null when what came back is not a verdict */
  parseVerdict(stdout: string): Verdict | null;
}
