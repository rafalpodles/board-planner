const SHOWN_VALUE = 300;

type Person = { username?: string } | string | null | undefined;

type Comment = {
  _id: string;
  author?: Person;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  reactions?: { emoji: string }[];
};

const nameOf = (person: Person) => (person && typeof person === "object" ? (person.username ?? null) : null);

/**
 * A comment as a line: the id an edit or a delete is addressed by, who wrote it and when, and the
 * reactions as counts. Oldest first, the way the task page reads, a page at a time.
 */
export function commentLines(comments: Comment[]) {
  return comments.map((comment) => {
    const counts = new Map<string, number>();
    for (const { emoji } of comment.reactions ?? []) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    return {
      id: String(comment._id),
      author: nameOf(comment.author),
      body: comment.body,
      createdAt: comment.createdAt ?? null,
      edited: !!comment.updatedAt && !!comment.createdAt && comment.updatedAt !== comment.createdAt,
      reactions: [...counts].map(([emoji, count]) => ({ emoji, count })),
    };
  });
}

type Activity = {
  user?: Person;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  createdAt?: string;
  cleared?: boolean;
};

const clip = (value: string) => (value.length > SHOWN_VALUE ? `${value.slice(0, SHOWN_VALUE)}…` : value);

/**
 * The history the task page shows, newest first, as lines. `field` is the field that changed — or, for a
 * checklist row, the id of the criterion — and a long value (a description) is clipped: what an agent
 * asks the history is what changed and by whom, not for the text back.
 */
export function activityLines(logs: Activity[], limit: number) {
  return logs.slice(0, limit).map((log) => ({
    at: log.createdAt ?? null,
    by: nameOf(log.user),
    action: log.action,
    field: log.field || null,
    from: clip(log.oldValue ?? ""),
    to: log.cleared ? "(cleared)" : clip(log.newValue ?? ""),
  }));
}
