"use client";

import type { CSSProperties } from "react";
import { ApiProjectCategory, ApiUser, PRIORITY_LABELS } from "@/types";
import { categoryColor } from "@/lib/category-colors";
import { Avatar, PriorityBars } from "./atoms";
import type { TaskDraft } from "./useTaskEditor";

interface MobileSummaryProps {
  draft: TaskDraft;
  assignee: ApiUser | undefined;
  categories: ApiProjectCategory[];
  onOpenDetails: () => void;
}

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-xs";

/** The handful of fields worth seeing without opening the sheet */
export function MobileSummary({
  draft,
  assignee,
  categories,
  onOpenDetails,
}: MobileSummaryProps) {
  return (
    <div className="flex flex-wrap gap-2 lg:hidden">
      <span className={CHIP}>
        <PriorityBars priority={draft.priority} />
        {PRIORITY_LABELS[draft.priority]}
      </span>
      <span
        className={`${CHIP} chip chip-custom border-transparent`}
        style={
          {
            "--chip":
              categoryColor(categories, draft.category) || "var(--color-text-muted)",
          } as CSSProperties
        }
      >
        {draft.category}
      </span>
      <span className={CHIP}>
        <Avatar name={assignee?.fullName} size={18} />
        {assignee ? assignee.fullName : "Unassigned"}
      </span>
      <button
        type="button"
        onClick={onOpenDetails}
        className={`${CHIP} focus-ring text-text-muted transition-colors hover:bg-bg-hover hover:text-text`}
      >
        All details
      </button>
    </div>
  );
}
