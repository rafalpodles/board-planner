import { DELETE as remove, PATCH as patch, PUT as put } from "@/lib/task-comment-route";
import { throughCatchAll } from "@/lib/through-catch-all";

const names = ["projectId", "taskId", "commentId"];

export const PUT = throughCatchAll(names, put);
export const PATCH = throughCatchAll(names, patch);
export const DELETE = throughCatchAll(names, remove);
