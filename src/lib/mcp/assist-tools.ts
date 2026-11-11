import { z } from "zod";
import { echo } from "@/lib/echo";
import { RELEASE_NOTE_TONES } from "@/ee/ai/release-notes";
import { SUMMARY_KINDS } from "@/ee/ai/summaries";
import { DEFAULT_WEEKS, MAX_WEEKS } from "@/lib/insights";
import type { ApiTaskTriage } from "@/types";
import type { PlannerClient } from "./planner-client";
import { clientFrom, json, type RegisterTool } from "./tool-kit";
import { strictInput } from "./strict-input";
import { findSprint, type SprintRow } from "./sprints";

export const ASK_PM_WAIT_MS = 45_000;
const PROJECT_PARAM = z.string().describe("Project key (e.g. 'CP')");
const SPRINT_PARAM = z.string().describe("A sprint, by name or id — list_sprints lists them");

async function sprintId(client: PlannerClient, projectId: string, sprint: string): Promise<string> {
  return String(findSprint(sprint, (await client.listSprints(projectId)) as SprintRow[])._id);
}

const triageLines = (triage: ApiTaskTriage | null) =>
  triage
    ? {
        state: triage.state,
        mode: triage.mode,
        suggestions: triage.suggestions.map((s) => ({
          id: s._id,
          field: s.field,
          ...(s.fieldId ? { fieldId: s.fieldId } : {}),
          value: s.value,
          reason: s.reason,
          outcome: s.outcome,
          ...(s.previous !== undefined ? { previous: s.previous } : {}),
        })),
      }
    : null;

export function registerAssistTools(registerTool: RegisterTool): void {
  registerTool(
    "triage_task",
    {
      description:
        "Read what AI triage suggested for a task (category, priority, fields), or act on one suggestion: apply it, " +
        "dismiss it, or undo an applied one. Without action, reads. Triage runs on new tasks when the board's " +
        "triageMode is suggest or auto (update_project).",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        suggestion: z.string().optional().describe("The suggestion's id, from a read"),
        action: z.enum(["apply", "dismiss", "undo"]).optional(),
      }),
    },
    async ({ taskKey, suggestion, action }, extra) => {
      if ((suggestion === undefined) !== (action === undefined)) {
        throw new Error("Name both suggestion and action, or neither to read. Nothing was written.");
      }
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const { triage } =
        suggestion && action
          ? await client.actOnTriage(projectId, taskId, suggestion, action)
          : await client.getTriage(projectId, taskId);
      return json({ taskKey: taskKey.toUpperCase(), triage: triageLines(triage) });
    }
  );

  registerTool(
    "find_duplicates",
    {
      description:
        "Ask the AI which tasks on a board already cover a title and description — before filing one, or for an " +
        "existing task by its key. Spends the organisation's AI allowance; a person may run 30 checks per 15 minutes.",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        title: z.string(),
        description: z.string().optional(),
        taskKey: z.string().optional().describe("An existing task to check, left out of its own answer"),
      }),
    },
    async ({ project, title, description, taskKey }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const taskId = taskKey ? (await client.resolveTaskKey(taskKey)).taskId : undefined;
      return json(
        await client.findDuplicates(proj._id, { title, ...(description !== undefined ? { description } : {}), ...(taskId ? { taskId } : {}) })
      );
    }
  );

  registerTool(
    "generate_task",
    {
      description:
        "Draft a task from a short prompt with the board's AI Assist, which reads the board and its repository's " +
        "README. Answers with the draft only; create_task files it. Spends the organisation's AI allowance; a person " +
        "may run 20 per 15 minutes.",
      inputSchema: strictInput({ project: PROJECT_PARAM, prompt: z.string().describe("What the task is about") }),
    },
    async ({ project, prompt }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.draftTask(proj._id, prompt));
    }
  );

  registerTool(
    "release_notes",
    {
      description:
        "Write release notes, as markdown, from what reached a done column and the pull requests merged — over a sprint " +
        "or between two days. tone: changelog (for the team) or customer. Spends the organisation's AI allowance.",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        sprint: SPRINT_PARAM.optional(),
        from: z.string().optional().describe("First day, YYYY-MM-DD, when no sprint is named"),
        to: z.string().optional().describe("Last day, YYYY-MM-DD"),
        tone: z.enum(RELEASE_NOTE_TONES).optional(),
      }),
    },
    async ({ project, sprint, from, to, tone }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(
        await client.releaseNotes(proj._id, {
          ...(sprint ? { sprintId: await sprintId(client, proj._id, sprint) } : { from, to }),
          ...(tone ? { tone } : {}),
        })
      );
    }
  );

  registerTool(
    "summarize",
    {
      description:
        "Write a summary of a board as markdown: standup (the team's last day), sprint (how one sprint is going) or " +
        "project (the last week). With post, it is also sent to the board's team chat channel. Spends the organisation's AI allowance.",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        kind: z.enum(SUMMARY_KINDS),
        sprint: SPRINT_PARAM.optional().describe("The sprint, for kind sprint"),
        post: z.boolean().optional().describe("Also post it to the board's team channel"),
      }),
    },
    async ({ project, kind, sprint, post }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      if (kind === "sprint" && !sprint) throw new Error("A sprint summary names its sprint.");
      const written = await client.summarize(proj._id, {
        kind,
        ...(kind === "sprint" && sprint ? { sprintId: await sprintId(client, proj._id, sprint) } : {}),
      });
      let posted: unknown = undefined;
      if (post) {
        if (!written.sealed) {
          const why =
            written.channels > 0
              ? "this instance cannot post summaries (no ENCRYPTION_KEY)"
              : `${echo(project.toUpperCase())} has no team channel to post to`;
          throw new Error(`Not posted: ${why}. The summary is below:\n\n${written.markdown}`);
        }
        posted = await client.postSummary(proj._id, written.sealed);
      }
      return json({ markdown: written.markdown, ...(post ? { posted } : {}) });
    }
  );

  registerTool(
    "get_insights",
    {
      description:
        "A board's delivery insights: throughput, cycle and lead time, the work in progress and how long it has been " +
        "open, and the DORA metrics, over the last weeks or one sprint, optionally for one category. Needs the " +
        "insights feature of the organisation's plan.",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        weeks: z.number().int().min(1).max(MAX_WEEKS).optional().describe(`How many weeks back (default ${DEFAULT_WEEKS})`),
        sprint: SPRINT_PARAM.optional(),
        category: z.string().optional(),
      }),
    },
    async ({ project, weeks, sprint, category }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(
        await client.getInsights(proj._id, {
          ...(weeks !== undefined ? { weeks: String(weeks) } : {}),
          ...(sprint ? { sprint: await sprintId(client, proj._id, sprint) } : {}),
          ...(category ? { category } : {}),
        })
      );
    }
  );

  registerTool(
    "ask_pm",
    {
      description:
        "Send the board's PM agent one message and wait for its answer, with the actions it took — the same as the PM " +
        "chat in the app. It acts as the pm account and may change tasks. One conversation at a time per board. A turn " +
        `still running after ${ASK_PM_WAIT_MS / 1000} seconds keeps running: the answer says so, and pm_messages reads ` +
        "it once it is done. Counted in the organisation's AI allowance.",
      inputSchema: strictInput({ project: PROJECT_PARAM, message: z.string().max(10_000) }, { writes: true }),
    },
    async ({ project, message }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const waited = AbortSignal.timeout(ASK_PM_WAIT_MS);
      const turn = await client
        .askPm(proj._id, message, extra.signal ? AbortSignal.any([extra.signal, waited]) : waited)
        .catch((err) => {
          if (waited.aborted) return null;
          throw err;
        });
      if (!turn) {
        return json({ pending: true, note: "The PM is still working on this. Its answer and actions arrive in pm_messages." });
      }
      if (!turn.ok) throw new Error(turn.error ?? "The PM turn failed");
      return json({ answer: turn.message, actions: turn.actions, ...(turn.interrupted ? { interrupted: true } : {}) });
    }
  );

  registerTool(
    "pm_messages",
    {
      description:
        "The board's PM conversation, newest last: what each person asked, the PM's answers, and the actions it " +
        "took. Reads the caller's own conversation with the PM, as the PM chat in the app shows it.",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        limit: z.number().int().min(1).max(100).optional().describe("How many of the latest messages (default 20)"),
      }),
    },
    async ({ project, limit }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const { messages } = await client.pmMessages(proj._id, limit ?? 20);
      return json(
        messages.map((m) => ({
          role: m.role,
          at: m.createdAt,
          content: m.content,
          ...(m.actions?.length ? { actions: m.actions.map((a) => ({ tool: a.tool, taskKey: a.taskKey, summary: a.summary })) } : {}),
        }))
      );
    }
  );

  registerTool(
    "run_pm_review",
    {
      description:
        "Start a board review by the PM agent now, rather than at its scheduled hour: it reads the board and comments " +
        "on what needs attention, without moving or creating tasks. Needs the project owner and the PM agent on. " +
        "Answers at once; the review's comments arrive on the board.",
      inputSchema: strictInput({ project: PROJECT_PARAM }, { writes: true }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      await client.startPmReview(proj._id);
      return json({ started: true });
    }
  );

  registerTool(
    "pm_usage",
    {
      description: "What the board's PM agent has used today: turns, model calls and tokens. Needs the project owner.",
      inputSchema: strictInput({ project: PROJECT_PARAM }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.pmUsage(proj._id));
    }
  );

  registerTool(
    "list_my_machines",
    {
      description:
        "The caller's own worker machines: name, host, version, when each was last seen and its state (live, paused, " +
        "stale…). Enrolling, pausing or removing a machine is done in the app.",
      inputSchema: strictInput({}),
    },
    async (_args, extra) => json(await clientFrom(extra).listMyMachines())
  );
}
