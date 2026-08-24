import { ApiTask, ApiUserSummary } from "@/types";

/**
 * The person a task is assigned to, as this view can name them.
 *
 * The roster holds only people who reach the board, and somebody assigned before they lost access
 * is still the assignee — so the roster is not enough on its own, and every surface that resolves a
 * name out of it alone renders "Unassigned" over a task the server has assigned. That was the
 * defect in the rail and, one component over, in the mobile summary; both now ask this.
 *
 * Keyed on the DRAFT, which is what an unsaved edit has already changed, with the stored task used
 * only to put a full name to a handle the roster no longer carries.
 */
export function assigneeToShow(
  users: ApiUserSummary[],
  draftAssignee: string | null,
  stored: ApiTask["assignee"]
): ApiUserSummary | undefined {
  if (!draftAssignee) return undefined;

  const onRoster = users.find((u) => u.username === draftAssignee);
  if (onRoster) return onRoster;

  const named =
    stored && typeof stored === "object" && stored.username === draftAssignee
      ? stored.fullName || draftAssignee
      : draftAssignee;

  // The id is the handle: this person is not on the roster, so there is no id to be had, and
  // nothing reads it — the picker keys on username and the label is the name.
  return { _id: draftAssignee, username: draftAssignee, fullName: named };
}
