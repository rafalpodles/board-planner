import { organisationDomain } from "@/lib/organisation-host";
import type { BudgetRefusal } from "./budget";

const number = (value: number) => value.toLocaleString("en-US");
const date = (at: Date) => at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** What a refusal says: the limit, the counter and when it starts again, so that it cannot be mistaken for an outage */
export function describeBudgetRefusal(refusal: BudgetRefusal): string {
  const counter = `${number(refusal.used)} of ${number(refusal.limit)}`;
  const own = organisationDomain() !== null ? " Add your own key in Settings → AI key to keep going." : "";
  if (refusal.scope === "day") {
    return `AI is paused for today: this organisation has used ${counter} AI tokens of its daily ceiling. It starts again at 00:00 UTC, ${date(refusal.resetsAt ?? new Date())}.${own}`;
  }
  if (refusal.scope === "trial") {
    return `AI is unavailable: this organisation has used ${counter} AI tokens, the allowance of its trial.${own}`;
  }
  return `AI is unavailable: this organisation has used ${counter} AI tokens, its allowance for the month. It renews on ${date(refusal.resetsAt ?? new Date())} (UTC).${own}`;
}

/** What a refusal says when the operator has switched off the use of its key for this organisation */
export function describeAiLock(reason: string): string {
  const own = organisationDomain() !== null ? " Add your own key in Settings → AI key to keep going." : "";
  const why = reason.trim().replace(/[.\s]+$/, "");
  return `AI is switched off for this organisation by the operator${why ? `: ${why}` : ""}.${own}`;
}
