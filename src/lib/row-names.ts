/**
 * One name per repeated row, disambiguated only where it has to be.
 *
 * BP-510 gave every control in a settings row the row's own name, which only tells the rows apart
 * while those names differ — and nothing makes them. `notifications/route.ts` asks a channel name
 * to be non-empty and nothing more, so two rooms called `alerts` on Slack and Discord are an
 * ordinary thing to have. Webhooks are worse: they have no name at all, so the row is identified
 * by `maskSecretUrl`'s output, which keeps only the origin and the last four characters — a path
 * of four characters or fewer contributes nothing, and `/ok` and `/x` on one host mask to exactly
 * the same string.
 *
 * A name shared by two rows is the defect this all exists to remove, so a collision gets its
 * position appended. Only a collision: appending to every row would put "(1)" beside a name that
 * was already unambiguous, and a reader hears the position on every row instead of never.
 */
export function distinctRowNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return names.map((name, index) => ((counts.get(name) ?? 0) > 1 ? `${name} (${index + 1})` : name));
}
