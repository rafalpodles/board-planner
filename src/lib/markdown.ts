import matter from "gray-matter";
import {
  ParsedTask,
  Category,
  Difficulty,
  TaskStatus,
  CATEGORIES,
  DIFFICULTIES,
  TASK_STATUSES,
  ITask,
  IUser,
  IProject,
} from "@/types";

const TASK_SEPARATOR = /\n={3,}\n/;

export function parseTasksFromMarkdown(md: string): ParsedTask[] {
  const chunks = md.split(TASK_SEPARATOR).filter((c) => c.trim());

  return chunks.map((chunk) => {
    const { data, content } = matter(chunk.trim());

    if (!data.title) {
      throw new Error("Task frontmatter must include 'title'");
    }
    if (!data.category || !CATEGORIES.includes(data.category as Category)) {
      throw new Error(
        `Task "${data.title}" must have a valid category: ${CATEGORIES.join(", ")}`
      );
    }

    const task: ParsedTask = {
      title: data.title,
      category: data.category as Category,
    };

    if (data.component) task.component = data.component;
    if (data.difficulty && DIFFICULTIES.includes(data.difficulty as Difficulty)) {
      task.difficulty = data.difficulty as Difficulty;
    }
    if (data.status && TASK_STATUSES.includes(data.status as TaskStatus)) {
      task.status = data.status as TaskStatus;
    }
    if (data.assignee) task.assignee = data.assignee;

    // Parse body sections
    const descMatch = content.match(
      /## Description\s*\n([\s\S]*?)(?=\n## |$)/
    );
    if (descMatch) {
      task.description = descMatch[1].trim();
    }

    const acMatch = content.match(
      /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## |$)/
    );
    if (acMatch) {
      task.acceptanceCriteria = acMatch[1].trim();
    }

    return task;
  });
}

interface TaskForExport {
  title: string;
  category: string;
  component?: string;
  difficulty?: string;
  status?: string;
  assignee?: { username: string } | string | null;
  description?: string;
  checklist?: { text: string; done: boolean }[];
}

export function exportTasksToMarkdown(tasks: (ITask | TaskForExport)[]): string {
  return tasks
    .map((task) => {
      const fm: Record<string, string> = {
        title: task.title,
        category: task.category,
      };
      if (task.component) fm.component = task.component;
      if (task.difficulty) fm.difficulty = task.difficulty;
      if (task.status) fm.status = task.status;
      if (task.assignee) {
        const assignee = task.assignee as IUser | { username: string } | string;
        fm.assignee =
          typeof assignee === "string"
            ? assignee
            : (assignee as IUser).username;
      }

      let body = "";
      if (task.description) {
        body += `\n## Description\n\n${task.description}\n`;
      }
      const checklist = "checklist" in task ? task.checklist : undefined;
      if (checklist && checklist.length > 0) {
        const items = checklist
          .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
          .join("\n");
        body += `\n## Acceptance Criteria\n\n${items}\n`;
      }

      return matter.stringify(body, fm).trim();
    })
    .join("\n\n===\n\n");
}
