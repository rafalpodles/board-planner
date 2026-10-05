export const BATCH_LIMIT = 30;
export const LINK_BATCH_LIMIT = 60;

/**
 * The task a reference in a batch names: a key of a task that exists already, or `#3` — the third item of
 * the same call, which has to come earlier and has to have been made. Anything else is the caller's own
 * key and goes on to the tool that links it, which refuses what it cannot find.
 */
export function referencedKey(ref: string, made: (string | null)[], position: number): string {
  const match = ref.trim().match(/^#(\d+)$/);
  if (!match) return ref.trim();
  const n = Number(match[1]);
  if (n < 1 || n >= position) {
    throw new Error(`${ref.trim()} must name an earlier item of this call (this is item #${position})`);
  }
  const key = made[n - 1];
  if (!key) throw new Error(`${ref.trim()} did not create a task, so there is nothing to link to`);
  return key;
}

export const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
