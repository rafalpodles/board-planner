import type { ApiTask } from "@/types";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";

export function undoneChecklist(items: { text: string }[] | undefined | null) {
  return (items || []).map((item) => ({ text: item.text, done: false }));
}

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
