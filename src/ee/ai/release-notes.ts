// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
import type { ScopedDb } from "@/lib/db-scope";
import { projectStatusHistories } from "@/lib/status-history";
import { taskKeyOf } from "@/lib/task-key";
import { decryptSecret } from "@/lib/encryption";
import { fetchMergedPullRequests, parseRepoString } from "@/lib/github";
import { fetchMergedRequests, parseGitlabRepo } from "@/lib/gitlab";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { gatewayWrite, type WriteResult } from "@/lib/ai-gateway";
import { resolveAiModel } from "@/lib/pm/availability";
import { NOT_ARCHIVED } from "@/lib/task-archive";

export const RELEASE_NOTE_TONES = ["changelog", "customer"] as const;
export type ReleaseNoteTone = (typeof RELEASE_NOTE_TONES)[number];

export interface ReleaseWindow {
  from: Date;
  // The last instant inside the window
  to: Date;
  label: string;
  // A sprint's notes are its own finished tasks, whenever they finished; a window of days takes those finished in it
  sprintId?: string;
}

interface PullRequest {
  title: string;
  url: string;
  mergedAt: string;
}

export interface ReleaseMaterial {
  window: { from: string; to: string; label: string };
  tasks: { key: string; title: string; category: string; description: string; pullRequests: PullRequest[] }[];
  pullRequestsWithoutTask: PullRequest[];
  // What could not be included, said to the model and to the reader rather than left out quietly
  tasksLeftOut: number;
  pullRequestsIncomplete: boolean;
  repositoryUnread: boolean;
}

const DESCRIPTION_CHARS = 600;
export const MAX_TASKS = 300;

const within = (at: Date | null | undefined, w: ReleaseWindow) => !!at && at >= w.from && at <= w.to;

type RepositoryProject = Parameters<typeof projectRepositoryUrl>[0] & {
  githubToken?: string | null;
  gitlabToken?: string | null;
  gitlabHost?: string;
};

/** Merged in the window, read from the repository itself by the date of the merge */
async function mergedIn(project: RepositoryProject, organisation: ScopedDb["organisation"], window: ReleaseWindow): Promise<{ pulls: PullRequest[]; complete: boolean }> {
  const url = projectRepositoryUrl(project);
  if (!url) return { pulls: [], complete: true };
  const provider = repositoryProvider(project);
  if (provider === "github" && project.githubToken) {
    const parsed = parseRepoString(url);
    if (!parsed) return { pulls: [], complete: true };
    const { pulls, complete } = await fetchMergedPullRequests(parsed.owner, parsed.repo, decryptSecret(project.githubToken, organisation), window.from, window.to);
    return { pulls: pulls.filter((pr) => within(new Date(pr.mergedAt), window)), complete };
  }
  if (provider === "gitlab" && project.gitlabToken) {
    const path = parseGitlabRepo(url);
    if (!path) return { pulls: [], complete: true };
    const { requests, complete } = await fetchMergedRequests(project.gitlabHost || "https://gitlab.com", path, decryptSecret(project.gitlabToken, organisation), window.from);
    return {
      pulls: requests.filter((mr) => mr.merged_at && within(new Date(mr.merged_at), window)).map((mr) => ({ title: mr.title, url: mr.web_url, mergedAt: mr.merged_at! })),
      complete,
    };
  }
  return { pulls: [], complete: true };
}

/** What shipped: the tasks finished, with their merged pull requests, and merges no task of the board links */
export async function releaseMaterial(db: ScopedDb, projectId: string, window: ReleaseWindow): Promise<ReleaseMaterial | null> {
  const project = await db.Project.findById(projectId, "key githubRepo repositoryUrl gitlabRepo gitlabHost githubToken gitlabToken").lean();
  if (!project) return null;

  const finished = (await projectStatusHistories(db, projectId)).filter(
    (t) =>
      !t.archived &&
      t.role === "done" &&
      (window.sprintId ? t.sprint === window.sprintId : t.history.kind === "recorded" && within(t.history.finishedAt, window))
  );
  const kept = finished.slice(0, MAX_TASKS);
  const details = await db.Task.find(
    { project: projectId, _id: { $in: kept.map((t) => t.taskId) }, ...NOT_ARCHIVED },
    "_id description linkedPRs"
  ).lean<{ _id: unknown; description?: string; linkedPRs?: { title: string; url: string; mergedAt?: Date | null }[] }[]>();
  const byId = new Map(details.map((d) => [String(d._id), d]));

  let merged: { pulls: PullRequest[]; complete: boolean } = { pulls: [], complete: true };
  let repositoryUnread = false;
  try {
    merged = await mergedIn(project as RepositoryProject, db.organisation, window);
  } catch (err) {
    // The reason goes to the log: what a repository host says is not for every member of the board, nor the model
    console.error("Release notes: the repository could not be read:", err instanceof Error ? err.message : err);
    repositoryUnread = true;
  }
  const linked = merged.pulls.length
    ? new Set(
        (await db.Task.find({ project: projectId, "linkedPRs.url": { $in: merged.pulls.map((pr) => pr.url) } }, "linkedPRs.url").lean<{ linkedPRs?: { url: string }[] }[]>())
          .flatMap((t) => (t.linkedPRs ?? []).map((pr) => pr.url))
      )
    : new Set<string>();

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    tasks: kept.map((t) => {
      const d = byId.get(t.taskId);
      return {
        key: taskKeyOf(project.key, t.taskNumber),
        title: t.title,
        category: t.category,
        description: (d?.description ?? "").slice(0, DESCRIPTION_CHARS),
        pullRequests: (d?.linkedPRs ?? [])
          .filter((pr) => pr.mergedAt)
          .map((pr) => ({ title: pr.title, url: pr.url, mergedAt: new Date(pr.mergedAt!).toISOString() })),
      };
    }),
    pullRequestsWithoutTask: merged.pulls.filter((pr) => !linked.has(pr.url)),
    tasksLeftOut: finished.length - kept.length,
    pullRequestsIncomplete: !merged.complete,
    repositoryUnread,
  };
}

const TONE: Record<ReleaseNoteTone, string> = {
  changelog:
    "Write a changelog for developers: short, factual lines, each ending with the task key or pull request link it comes from.",
  customer:
    "Write release notes for the product's customers: plain language about what they can now do or what no longer goes wrong. Leave out internal work nobody outside the team would notice, and keep each task key at the end of its line.",
};

export function releaseNoteInstructions(tone: ReleaseNoteTone): string {
  return [
    "You write release notes in Markdown from a list of finished work.",
    TONE[tone],
    "Group the lines under a heading per category, using the categories given. Put pull requests that belong to no task under a heading of their own named Other changes.",
    "Mention every task and every pull request given, once, and nothing that is not given. Do not invent version numbers, dates or figures.",
    "If tasksLeftOut is above zero, or pullRequestsIncomplete or repositoryUnread is true, end with one line saying the list is not complete.",
    "Answer with the Markdown only.",
  ].join(" ");
}

export function isEmpty(material: ReleaseMaterial): boolean {
  return material.tasks.length === 0 && material.pullRequestsWithoutTask.length === 0;
}

export async function writeReleaseNotes(
  db: ScopedDb,
  context: { projectId: string; userId: string },
  material: ReleaseMaterial,
  tone: ReleaseNoteTone
): Promise<WriteResult> {
  return gatewayWrite(db, { ...context, source: "release_notes" }, { model: await resolveAiModel(db), instructions: releaseNoteInstructions(tone), data: material });
}
