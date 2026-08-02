import { ApiClient, StatusIds } from "./api.js";
import { Outbox, OutboxOp } from "./outbox.js";
import { scrub } from "./scrub.js";
import { ClaimedTask } from "./types.js";

const MAX_REASON_CHARS = 2000;

export interface Reporter {
  blocked(task: ClaimedTask, reason: string): Promise<void>;
  gateRejected(task: ClaimedTask, gate: string, reason: string, branch: string): Promise<void>;
  released(task: ClaimedTask, reason: string): Promise<void>;
  requeued(task: ClaimedTask, reason: string): Promise<void>;
  merged(task: ClaimedTask, prUrl: string, summary: string): Promise<void>;
  failed(task: ClaimedTask, reason: string): Promise<void>;
}

type Log = (message: string) => void;

// Every agent- and gate-authored string entering a board comment goes through here. Redacted
// before the cut, not after: a secret straddling it would otherwise survive as a prefix too short
// for any pattern to match — up to 60 of a worker credential's 64 hex characters.
function safeText(text: string): string {
  const safe = scrub(text);
  if (safe.length <= MAX_REASON_CHARS) return safe;
  return `${safe.slice(0, MAX_REASON_CHARS)}\n[truncated to ${MAX_REASON_CHARS} characters]`;
}

export function createReporter(
  api: ApiClient,
  statusIds: StatusIds,
  log: Log = (message) => console.error(message),
  outbox?: Outbox
): Reporter {
  const lastRelease = new Map<string, string>();

  // Losing a report strands the task: the work is merged but the board still shows it active,
  // and claimNextTask only ever looks at the approved column
  function queue(task: ClaimedTask, op: OutboxOp, what: string, error: unknown): void {
    log(`${task.taskKey}: could not ${what}: ${String(error)}`);
    if (outbox) outbox.add(op);
  }

  async function comment(task: ClaimedTask, body: string): Promise<boolean> {
    try {
      await api.comment(task.projectId, task.taskId, body);
      return true;
    } catch (error) {
      queue(
        task,
        { kind: "comment", projectId: task.projectId, taskId: task.taskId, body },
        "post the board comment",
        error
      );
      return false;
    }
  }

  async function move(task: ClaimedTask, status: string): Promise<void> {
    try {
      await api.setStatus(task.projectId, task.taskId, status);
    } catch (error) {
      queue(
        task,
        { kind: "status", projectId: task.projectId, taskId: task.taskId, status },
        `move the task to ${status}`,
        error
      );
    }
  }

  async function release(task: ClaimedTask, options?: { refund?: boolean }): Promise<void> {
    try {
      await (options
        ? api.release(task.projectId, task.taskId, options)
        : api.release(task.projectId, task.taskId));
    } catch (error) {
      queue(
        task,
        {
          kind: "release",
          projectId: task.projectId,
          taskId: task.taskId,
          refund: options?.refund !== false,
        },
        "return the task to the queue",
        error
      );
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
        statusIds.review,
        `The execution worker stopped: the agent reported it could not finish.\n\n${safeText(reason)}`
      );
    },

    async gateRejected(task, gate, reason, branch) {
      await report(
        task,
        statusIds.review,
        `The execution worker blocked the merge at the **${gate}** gate.\n\n${safeText(reason)}\n\nThe work is pushed to \`${branch}\` for inspection.`
      );
    },

    async released(task, reason) {
      const text = safeText(reason);
      if (lastRelease.get(task.taskId) !== text && (await comment(task, `Returned to the queue: ${text}`))) {
        lastRelease.set(task.taskId, text);
      }
      await release(task);
    },

    // Charges the attempt, unlike released — a crash that repeats has to run out of retries
    // instead of coming back forever
    async requeued(task, reason) {
      lastRelease.delete(task.taskId);
      const attempt = task.attempts > 0 ? ` on attempt ${task.attempts}` : "";
      await comment(task, `Returned to the queue after the run failed${attempt}.\n\n${safeText(reason)}`);
      await release(task, { refund: false });
    },

    async merged(task, prUrl, summary) {
      await report(task, statusIds.done, `Merged ${prUrl}\n\n${safeText(summary)}`);
    },

    async failed(task, reason) {
      const attempt = task.attempts > 0 ? ` on attempt ${task.attempts}` : "";
      await report(task, statusIds.review, `The execution worker gave up${attempt}.\n\n${safeText(reason)}`);
    },
  };
}
