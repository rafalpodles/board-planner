import { ApiTask, ApiUserSummary } from "@/types";

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

  return { _id: draftAssignee, username: draftAssignee, fullName: named };
}
