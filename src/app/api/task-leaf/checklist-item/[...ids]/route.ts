import { DELETE as remove, PATCH as patch } from "@/lib/checklist-item-route";
import { throughCatchAll } from "@/lib/through-catch-all";

const names = ["projectId", "taskId", "itemId"];

export const PATCH = throughCatchAll(names, patch);
export const DELETE = throughCatchAll(names, remove);
