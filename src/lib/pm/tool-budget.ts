/**
 * How many MCP tools a turn can carry before the turn stops working.
 *
 * Derived from BP-569, measured on production 2026-09-06 rather than guessed. Two servers with
 * empty allowlists put 86 tool schemas into every one of a turn's up to MAX_STEPS calls, which
 * cost 45-68k tokens per call and left the model wandering until the step limit ran out. The same
 * project narrowed to 13 tools answered in one call for 18,747 tokens, history and system prompt
 * included. That puts a tool at very roughly 350 tokens of schema, so 40 is about 14k per call —
 * enough to be worth spending, small enough to leave the model room to answer.
 *
 * Nothing truncates at this number. A silently dropped tool is a worse bug than the one being
 * fixed here: the operator would see it ticked on screen and the agent would deny having it. The
 * budget only speaks.
 */
export const MCP_TOOL_BUDGET = 40;

/**
 * Ceiling on one server's stored allowlist. Lives here rather than in `config.ts` so the picker
 * can stop at the same number the validator refuses at, instead of letting an admin tick 51 tools
 * and lose the whole PM save to a 400 (BP-569 review).
 */
export const MAX_TOOL_ALLOWLIST = 50;

/**
 * Rough tokens one tool definition adds to every call of a turn. From the same BP-569 measurement:
 * 86 tools cost 45-68k per call, 13 cost 18,747 including system prompt and history. It is an
 * order of magnitude, not an invoice, and it is labelled as such wherever it is shown.
 */
export const TOKENS_PER_TOOL_ESTIMATE = 350;

export function estimateToolTokens(count: number): number {
  return count * TOKENS_PER_TOOL_ESTIMATE;
}

export interface ServerToolCount {
  name: string;
  count: number;
}

export interface ToolBudgetVerdict {
  budget: number;
  total: number;
  over: boolean;
  /** Every contributing server, largest first. Not a top-N — the whole blame list. */
  heaviest: ServerToolCount[];
  /** A server this caller could not count, so `total` is a floor rather than a figure. */
  incomplete: boolean;
}

export function assessToolBudget(
  servers: ServerToolCount[],
  budget: number = MCP_TOOL_BUDGET,
  incomplete = false
): ToolBudgetVerdict {
  // A server contributing nothing is not responsible for a flood, and naming it in the blame list
  // was the difference between the UI's count and the agent's (BP-569 review).
  const contributing = servers.filter((s) => s.count > 0);
  const total = contributing.reduce((sum, s) => sum + s.count, 0);
  return {
    budget,
    total,
    over: total > budget,
    heaviest: [...contributing].sort((a, b) => b.count - a.count),
    incomplete,
  };
}

/** Empty when there is nothing wrong, so a caller can render it without asking first. */
export function describeToolBudget(verdict: ToolBudgetVerdict): string {
  if (!verdict.over) return "";
  const blame = verdict.heaviest.map((s) => `${s.name} (${s.count})`).join(", ");
  // "at least", because a server that could not be counted contributes an unknown number and the
  // total is a floor. "would be" rather than "are": on the settings screen this describes the
  // configuration on screen, which may not be the saved one (BP-569 review 3).
  const count = verdict.incomplete ? `At least ${verdict.total}` : `${verdict.total}`;
  return (
    `${count} MCP tools would be sent to the model on every call of a turn, above the ` +
    `${verdict.budget} this agent is sized for: ${blame}. Turns get slower and may end without an ` +
    `answer. Narrow a server's tool list to fix it.`
  );
}
