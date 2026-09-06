export const MCP_TOOL_BUDGET = 40;

export const MAX_TOOL_ALLOWLIST = 50;

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
  heaviest: ServerToolCount[];
  incomplete: boolean;
}

export function assessToolBudget(
  servers: ServerToolCount[],
  budget: number = MCP_TOOL_BUDGET,
  incomplete = false
): ToolBudgetVerdict {
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

export function describeToolBudget(verdict: ToolBudgetVerdict): string {
  if (!verdict.over) return "";
  const blame = verdict.heaviest.map((s) => `${s.name} (${s.count})`).join(", ");
  const count = verdict.incomplete ? `At least ${verdict.total}` : `${verdict.total}`;
  return (
    `${count} MCP tools would be sent to the model on every call of a turn, above the ` +
    `${verdict.budget} this agent is sized for: ${blame}. Turns get slower and may end without an ` +
    `answer. Narrow a server's tool list to fix it.`
  );
}
