export interface OurUsage {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/** One row of OpenRouter's `GET /api/v1/activity`, as the API spells it */
export interface ProviderActivity {
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
}

export interface Figures {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface ReconciledModel {
  model: string;
  ours: Figures;
  theirs: Figures;
  /** (ours - theirs) / theirs: 0 where both are 0, Infinity where only ours is */
  difference: { calls: number; promptTokens: number; completionTokens: number };
  within: boolean;
}

export interface Reconciliation {
  models: ReconciledModel[];
  within: boolean;
}

const empty = (): Figures => ({ calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });

/** Our AI Assist rows name the model as the settings do (`gpt-4o-mini`), the provider as OpenRouter does (`openai/gpt-4o-mini`) */
export function providerModelName(name: string): string {
  const model = name.trim().toLowerCase();
  return model.includes("/") ? model : `openai/${model}`;
}

function relative(ours: number, theirs: number): number {
  if (ours === theirs) return 0;
  return theirs === 0 ? Infinity : (ours - theirs) / theirs;
}

/**
 * Sets what the gateway recorded for one UTC day beside what the provider reports for it, model by model. The gateway records
 * what each response reported, so the two agree by construction except for a call that was stopped (counted at its prompt's
 * estimate, with no completion) and a day's edge, which is why a tolerance is allowed and nothing is assumed.
 */
export function reconcile(ours: OurUsage[], theirs: ProviderActivity[], tolerance: number): Reconciliation {
  const byModel = new Map<string, { ours: Figures; theirs: Figures }>();
  const slot = (model: string) => {
    const key = providerModelName(model);
    const found = byModel.get(key) ?? { ours: empty(), theirs: empty() };
    byModel.set(key, found);
    return found;
  };
  for (const row of ours) {
    const { ours: sum } = slot(row.model);
    sum.calls += row.calls;
    sum.promptTokens += row.promptTokens;
    sum.completionTokens += row.completionTokens;
  }
  for (const row of theirs) {
    const { theirs: sum } = slot(row.model);
    sum.calls += row.requests;
    sum.promptTokens += row.prompt_tokens;
    sum.completionTokens += row.completion_tokens;
    sum.reasoningTokens += row.reasoning_tokens ?? 0;
  }

  const models = [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, { ours: o, theirs: t }]): ReconciledModel => {
      const difference = {
        calls: relative(o.calls, t.calls),
        promptTokens: relative(o.promptTokens, t.promptTokens),
        completionTokens: relative(o.completionTokens, t.completionTokens),
      };
      return { model, ours: o, theirs: t, difference, within: Object.values(difference).every((d) => Math.abs(d) <= tolerance) };
    });
  return { models, within: models.every((m) => m.within) };
}

const percent = (d: number) => (d === Infinity ? "only ours" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(2)}%`);

export function describeReconciliation(date: string, result: Reconciliation, tolerance: number): string {
  const lines = [`AI usage on ${date} (UTC): the gateway's rows against the provider's activity, tolerance ${(tolerance * 100).toFixed(1)}%`, ""];
  for (const m of result.models) {
    lines.push(
      `${m.within ? "ok  " : "DIFF"} ${m.model}`,
      `       calls       ours ${m.ours.calls}  theirs ${m.theirs.calls}  ${percent(m.difference.calls)}`,
      `       prompt      ours ${m.ours.promptTokens}  theirs ${m.theirs.promptTokens}  ${percent(m.difference.promptTokens)}`,
      `       completion  ours ${m.ours.completionTokens}  theirs ${m.theirs.completionTokens}  ${percent(m.difference.completionTokens)}` +
        (m.theirs.reasoningTokens ? `  (the provider also reports ${m.theirs.reasoningTokens} reasoning tokens)` : "")
    );
  }
  if (result.models.length === 0) lines.push("Nothing on either side: a day with no AI on the operator's key, or the wrong date.");
  lines.push("", result.within ? "Agrees within the tolerance." : "Does not agree within the tolerance: see the DIFF rows.");
  return lines.join("\n");
}

/** The provider's activity covers the last 30 completed UTC days, so that is what a day to check may be */
export function utcDayRange(date: string, now: Date = new Date()): { from: Date; to: Date } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "The day is YYYY-MM-DD" };
  const from = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== date) return { error: `${date} is not a day` };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (from.getTime() >= today) return { error: "The day has to be a completed UTC day: yesterday or before" };
  if (from.getTime() < today - 30 * 24 * 60 * 60 * 1000) return { error: "The provider keeps the last 30 completed UTC days" };
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}
