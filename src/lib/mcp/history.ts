const SHOWN_VALUE = 300;

type Person = { username?: string } | string | null | undefined;

type Comment = {
  _id: string;
  author?: Person;
  body: string;
  createdAt?: string;
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
      reactions: [...counts].map(([emoji, count]) => ({ emoji, count })),
    };
  });
}

type Activity = {
  user?: Person;
  action: string;
  field?: string;
  customField?: boolean;
  oldValue?: string;
  newValue?: string;
  createdAt?: string;
  cleared?: boolean;
};

const clip = (value: string) => (value.length > SHOWN_VALUE ? `${value.slice(0, SHOWN_VALUE)}…` : value);

/**
 * A description's text is not in the history row — the route blanks it and says only whether it was
 * cleared — so what is said is what the task page says: added, edited or removed.
 */
const describedChange = (log: Activity) => (log.cleared ? "(removed)" : log.oldValue ? "(edited)" : "(added)");

/**
 * The history the task page shows, newest first, as lines. `field` is the field that changed — or, for a
 * checklist row, the id of the criterion — and a long value is clipped: what an agent asks the history is
 * what changed and by whom, not for the text back.
 */
export function activityLines(logs: Activity[], limit: number) {
  return logs.slice(0, limit).map((log) => {
    const description = log.field === "description" && !log.customField && log.action === "updated";
    return {
      at: log.createdAt ?? null,
      by: nameOf(log.user),
      action: log.action,
      field: log.field || null,
      from: description ? "" : clip(log.oldValue ?? ""),
      to: description ? describedChange(log) : clip(log.newValue ?? ""),
    };
  });
}
