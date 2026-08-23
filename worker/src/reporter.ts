import { ApiClient, StatusIds } from "./api.js";
import { Outbox, OutboxOp } from "./outbox.js";
import { scrub } from "./scrub.js";
import { ClaimedTask } from "./types.js";

const MAX_REASON_CHARS = 2000;
// A patch is not a reason and does not fit in one. This is the refused change itself, and a human
// reading it on the board is the whole point of putting it there — cutting it to a reason's length
// would leave the first file and none of the rest.
const MAX_PATCH_COMMENT_CHARS = 12_000;

export interface Reporter {
  blocked(task: ClaimedTask, reason: string): Promise<void>;
  gateRejected(
    task: ClaimedTask,
    gate: string,
    reason: string,
    branch: string,
    /** The refused change itself, for a rejection whose branch is deliberately not pushed. */
    patch?: string
  ): Promise<void>;
  released(task: ClaimedTask, reason: string): Promise<void>;
  requeued(task: ClaimedTask, reason: string): Promise<void>;
  merged(task: ClaimedTask, prUrl: string, summary: string): Promise<void>;
  delivered(task: ClaimedTask, prUrl: string, summary: string): Promise<void>;
  failed(task: ClaimedTask, reason: string): Promise<void>;
}

type Log = (message: string) => void;

/**
 * The release comment each task last received, keyed by task id.
 *
 * Held by the caller because a reporter is built per run: kept inside one, the dedupe below can
 * never fire, and a fault that recurs on every poll writes the same comment — with its webhook,
 * its Slack message and its notification — every thirty seconds for as long as it lasts.
 */
export type ReleaseMemory = Map<string, string>;

// Every agent- and gate-authored string entering a board comment goes through here. Redacted
// before the cut, not after: a secret straddling the cut would otherwise survive as a prefix too
// short for its pattern to match. The dangerous shape is the length-exact one — a ghp_ PAT that
// loses a single trailing character stops matching entirely and publishes 35 of its 36 characters,
// which is 62 guesses. (The {32,} shapes degrade gracefully; at worst half a cpw_ credential.)
function safeText(text: string): string {
  const safe = scrub(text);
  if (safe.length <= MAX_REASON_CHARS) return safe;
  return `${safe.slice(0, MAX_REASON_CHARS)}\n[truncated to ${MAX_REASON_CHARS} characters]`;
}

// Same redaction as every other agent-authored string, a different bound. Scrubbed before the cut
// for the reason safeText gives: a secret straddling the cut would survive as an unmatched prefix.
function safePatch(patch: string): string {
  const safe = scrub(patch);
  if (safe.length <= MAX_PATCH_COMMENT_CHARS) return safe;
  const cut = safe.lastIndexOf("\n", MAX_PATCH_COMMENT_CHARS);
  return `${safe.slice(0, cut > 0 ? cut : MAX_PATCH_COMMENT_CHARS)}\n[patch truncated]`;
}

export function createReporter(
  api: ApiClient,
  statusIds: StatusIds,
  log: Log = (message) => console.error(message),
  outbox?: Outbox,
  lastRelease: ReleaseMemory = new Map()
): Reporter {

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

    async gateRejected(task, gate, reason, branch, patch) {
      // Conditional: a protected-paths refusal deliberately does not push, and the reason already
      // says where the work is. Promising a branch that is not on the remote sends a human looking.
      const where = branch ? `\n\nThe work is pushed to \`${branch}\` for inspection.` : "";
      // Without a branch, the refused change existed only in a worktree on one machine — and this
      // gate's entire demand is that a human read it. A patch in a comment executes nothing, so
      // the review can happen where the task is rather than requiring a shell on that laptop.
      const proposed = !branch && patch?.trim() ? `\n\nThe change it refused:\n\n\`\`\`diff\n${safePatch(patch)}\n\`\`\`` : "";
      await report(
        task,
        statusIds.review,
        `The execution worker blocked the merge at the **${gate}** gate.\n\n${safeText(reason)}${where}${proposed}`
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
      // The url is built by delivery.ts from gh output and its regex admits userinfo, so a
      // credential-bearing remote would otherwise publish its token as a permanent comment
      await report(task, statusIds.done, `Merged ${scrub(prUrl)}\n\n${safeText(summary)}`);
    },

    // The agent carried no Merge step: the branch is pushed and a pull request is open, so the
    // work is safe and a human decides. Review, not done — nothing has landed on the base branch.
    async delivered(task, prUrl, summary) {
      await report(
        task,
        statusIds.review,
        `Opened ${scrub(prUrl)} for review. The worker did not merge it.\n\n${safeText(summary)}`
      );
    },

    async failed(task, reason) {
      const attempt = task.attempts > 0 ? ` on attempt ${task.attempts}` : "";
      await report(task, statusIds.review, `The execution worker gave up${attempt}.\n\n${safeText(reason)}`);
    },
  };
}
