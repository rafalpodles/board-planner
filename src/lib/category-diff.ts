export interface CategoryDraft {
  _id?: string;
  name: string;
  color: string;
}

export interface CategoryChange {
  /** The name the server still holds — the PATCH keys on it, not on the new one */
  name: string;
  newName?: string;
  color: string;
}

export interface CategoryDiff {
  added: { name: string; color: string }[];
  removed: string[];
  changed: CategoryChange[];
}

/**
 * What the save bar has to send for a drafted category list. The API is per-category —
 * there is no bulk PUT — so the draft is reconciled into one request per actual change
 * rather than rewriting the whole array.
 */
export function categoryDiff(baseline: CategoryDraft[], next: CategoryDraft[]): CategoryDiff {
  const byId = new Map(baseline.filter((c) => c._id).map((c) => [c._id as string, c]));
  const keptIds = new Set(next.map((c) => c._id).filter(Boolean) as string[]);

  const added = next
    .filter((c) => !c._id)
    .map((c) => ({ name: c.name, color: c.color }));

  const removed = baseline
    .filter((c) => c._id && !keptIds.has(c._id))
    .map((c) => c.name);

  const changed: CategoryChange[] = [];
  for (const candidate of next) {
    const before = candidate._id ? byId.get(candidate._id) : undefined;
    if (!before) continue;
    const renamed = before.name !== candidate.name;
    if (!renamed && before.color === candidate.color) continue;
    changed.push({
      name: before.name,
      ...(renamed ? { newName: candidate.name } : {}),
      color: candidate.color,
    });
  }

  return { added, removed, changed };
}
