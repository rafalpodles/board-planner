import type { ApiTask } from "@/types";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";

/**
 * A copy is work to do, so it arrives unticked — the one answer both "make me another one of these"
 * paths give: `duplicatePayload` below, and the next occurrence in `createNextRecurrence`. The two
 * disagreed until BP-462, and a duplicate claiming three of its five steps were already done is the
 * half that bites.
 *
 * The `_id`s go with the ticks, deliberately: `checklistOrRefusal` keeps one when it is sent, which
 * left the copy's items carrying the original's subdocument ids.
 */
export function undoneChecklist(items: { text: string }[] | undefined | null) {
  return (items || []).map((item) => ({ text: item.text, done: false }));
}

// A plain slice at the cap can split a surrogate pair in two; the lone high surrogate left behind
// is valid JS but not valid Unicode, and becomes U+FFFD wherever the title is next serialised
// (JSON, then BSON).
function trimDanglingSurrogate(value: string): string {
  const lastUnit = value.charCodeAt(value.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? value.slice(0, -1) : value;
}

type DuplicableTask = Pick<
  ApiTask,
  | "title"
  | "description"
  | "priority"
  | "category"
  | "checklist"
  | "dueDate"
  | "customFieldValues"
  | "recurrence"
>;

/**
 * What "another one of these" copies — used by the task screen and by the board's context menu, so
 * the two cannot drift apart again (BP-462: one carried the priority, the other did not).
 *
 * Carried: the definition of the work, the rhythm and the priority included. A duplicated weekly
 * task that quietly never came back looked identical to one that did.
 *
 * Dropped, and each for its own reason:
 * - `status`, because columns are per project since CP-128 and a literal "planned" is a 400 in any
 *   project that renamed or rebuilt its board. Omitting it lets the server pick the backlog column.
 * - `assignee` and `sprint`, because they are the hand-over and the schedule rather than the work.
 *   Creating a task already assigned notifies the assignee (`createTask`), so carrying the name
 *   would hand somebody work nobody offered them — and it would have to be their username, which
 *   is not what a read task carries. A copy the server puts in the backlog has no business in the
 *   current sprint either.
 * - `agent`, which `POST /tasks` does not accept at all: choosing one is a separate hand-over
 *   gesture (BP-358), so a copy is nobody's to run until a person makes it.
 *
 * A recurrence carries all three because it continues a standing series — see the comments in
 * `createNextRecurrence`. A duplicate starts a new one.
 */
export function duplicatePayload(task: DuplicableTask) {
  return {
    title: trimDanglingSurrogate(`Copy of ${task.title}`.slice(0, TASK_TITLE_MAX_LENGTH)),
    description: task.description,
    priority: task.priority,
    category: task.category,
    checklist: undoneChecklist(task.checklist),
    dueDate: task.dueDate,
    customFieldValues: task.customFieldValues,
    recurrence: task.recurrence,
  };
}
