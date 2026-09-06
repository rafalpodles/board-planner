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
 *
 * **Appending a position is not itself guaranteed to land on an unused name.** Nothing stops a
 * channel from being typed in as literally `alerts (2)` — it is an ordinary string as far as the
 * form and the API are concerned. Two rows called `alerts` naively disambiguate to `alerts (1)`
 * and `alerts (2)`, and the second collides with the row that was already called that, silently
 * recreating the exact bug this function exists to close. So a synthesised name is checked
 * against every name already assigned — original and synthesised alike — and bumped again if it
 * collides, however unlikely that second collision is.
 */
export function distinctRowNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  const used = new Set<string>();
  return names.map((name, index) => {
    let candidate = (counts.get(name) ?? 0) > 1 ? `${name} (${index + 1})` : name;
    // The loop, not the `if`: a bumped candidate can itself collide with a later bump of an
    // earlier row, and that needs the same treatment rather than a single fixed retry.
    while (used.has(candidate)) candidate = `${candidate} (${index + 1})`;
    used.add(candidate);
    return candidate;
  });
}
