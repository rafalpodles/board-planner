import { CRITERION_TEXT_RULE, isValidCriterionText, rendersBlank } from "@/lib/identifiers";

/** A criterion's text as a body carries it: a string that shows something and breaks no rule, trimmed. */
export function criterionTextOrRefusal(value: unknown): { text: string } | { error: string } {
  if (typeof value !== "string" || rendersBlank(value)) return { error: "An acceptance criterion is required" };
  if (!isValidCriterionText(value.trim())) return { error: CRITERION_TEXT_RULE };
  return { text: value.trim() };
}
