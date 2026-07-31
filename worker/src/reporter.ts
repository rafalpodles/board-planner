import { ApiClient } from "./api.js";
import { ClaimedTask } from "./types.js";

const MAX_REASON_CHARS = 2000;

export interface Reporter {
  blocked(task: ClaimedTask, reason: string): Promise<void>;
  gateRejected(task: ClaimedTask, gate: string, reason: string, branch: string): Promise<void>;
  released(task: ClaimedTask, reason: string): Promise<void>;
  merged(task: ClaimedTask, prUrl: string, summary: string): Promise<void>;
  failed(task: ClaimedTask, reason: string): Promise<void>;
}

type Log = (message: string) => void;

function capped(text: string): string {
  if (text.length <= MAX_REASON_CHARS) return text;
  return `${text.slice(0, MAX_REASON_CHARS)}\n[truncated to ${MAX_REASON_CHARS} characters]`;
}

export function createReporter(api: ApiClient, log: Log = (message) => console.error(message)): Reporter {
  const lastRelease = new Map<string, string>();

  async function comment(task: ClaimedTask, body: string): Promise<boolean> {
    try {
      await api.comment(task.taskId, body);
      return true;
    } catch (error) {
      log(`${task.taskKey}: could not post the board comment: ${String(error)}`);
      return false;
    }
  }

  async function move(task: ClaimedTask, status: string): Promise<void> {
    try {
      await api.setStatus(task.taskId, status);
    } catch (error) {
      log(`${task.taskKey}: could not move the task to ${status}: ${String(error)}`);
    }
  }

  async function report(task: ClaimedTask, status: string, body: string): Promise<void> {
    lastRelease.delete(task.taskId);
    await comment(task, body);
    await move(task, status);
  }

  return {
    async blocked(task, reason) {
      await report(
        task,
        "needs_human_review",
        `The execution worker stopped: the agent reported it could not finish.\n\n${capped(reason)}`
      );
    },

    async gateRejected(task, gate, reason, branch) {
      await report(
        task,
        "needs_human_review",
        `The execution worker blocked the merge at the **${gate}** gate.\n\n${capped(reason)}\n\nThe work is pushed to \`${branch}\` for inspection.`
      );
    },

    async released(task, reason) {
      const text = capped(reason);
      if (lastRelease.get(task.taskId) !== text && (await comment(task, `Returned to the queue: ${text}`))) {
        lastRelease.set(task.taskId, text);
      }
      await move(task, "todo");
    },

    async merged(task, prUrl, summary) {
      await report(task, "done", `Merged ${prUrl}\n\n${capped(summary)}`);
    },

    async failed(task, reason) {
      const attempt = task.attempts > 0 ? ` on attempt ${task.attempts}` : "";
      await report(task, "needs_human_review", `The execution worker gave up${attempt}.\n\n${capped(reason)}`);
    },
  };
}
