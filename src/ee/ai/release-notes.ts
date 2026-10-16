// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
import type { ScopedDb } from "@/lib/db-scope";
import { projectStatusHistories } from "@/lib/status-history";
import { taskKeyOf } from "@/lib/task-key";
import { decryptSecret } from "@/lib/encryption";
import { fetchPullRequests, matchPRsToTasks, parseRepoString } from "@/lib/github";
import { fetchMergeRequests, matchMRsToTasks, parseGitlabRepo } from "@/lib/gitlab";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { gatewayWrite, type WriteResult } from "@/lib/ai-gateway";

export const RELEASE_NOTE_TONES = ["changelog", "customer"] as const;
export type ReleaseNoteTone = (typeof RELEASE_NOTE_TONES)[number];

export interface ReleaseWindow {
  from: Date;
  to: Date;
  label: string;
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
  // Said when the repository could not be read: the notes then cover tasks only
  repositoryUnread: string | null;
}

const DESCRIPTION_CHARS = 600;
const MAX_TASKS = 300;

const within = (at: Date | null | undefined, w: ReleaseWindow) => !!at && at >= w.from && at <= w.to;

/** Merged in the window and claimed by no task of this board, read from the repository itself */
async function unclaimedMerges(
  project: Parameters<typeof projectRepositoryUrl>[0] & {
    key: string;
    formerKeys?: string[];
    githubToken?: string | null;
    gitlabToken?: string | null;
    gitlabHost?: string;
  },
  organisation: ScopedDb["organisation"],
  window: ReleaseWindow
): Promise<PullRequest[]> {
  const url = projectRepositoryUrl(project);
  if (!url) return [];
  const provider = repositoryProvider(project);
  if (provider === "github" && project.githubToken) {
    const parsed = parseRepoString(url);
    if (!parsed) return [];
    const raw = await fetchPullRequests(parsed.owner, parsed.repo, decryptSecret(project.githubToken, organisation));
    const claimed = new Set(matchPRsToTasks(raw, project.key, project.formerKeys ?? []).map((pr) => pr.url));
    return raw
      .filter((pr) => pr.merged_at && within(new Date(pr.merged_at), window) && !claimed.has(pr.html_url))
      .map((pr) => ({ title: pr.title, url: pr.html_url, mergedAt: pr.merged_at! }));
  }
  if (provider === "gitlab" && project.gitlabToken) {
    const path = parseGitlabRepo(url);
    if (!path) return [];
    const raw = await fetchMergeRequests(project.gitlabHost || "https://gitlab.com", path, decryptSecret(project.gitlabToken, organisation));
    const claimed = new Set(matchMRsToTasks(raw, project.key, project.formerKeys ?? []).map((mr) => mr.url));
    return raw
      .filter((mr) => mr.merged_at && within(new Date(mr.merged_at), window) && !claimed.has(mr.web_url))
      .map((mr) => ({ title: mr.title, url: mr.web_url, mergedAt: mr.merged_at! }));
  }
  return [];
}

/** What shipped in a window: the tasks that reached a done column in it with their merged pull requests, and merges no task claims */
export async function releaseMaterial(db: ScopedDb, projectId: string, window: ReleaseWindow): Promise<ReleaseMaterial | null> {
  const project = await db.Project.findById(
    projectId,
    "key formerKeys githubRepo repositoryUrl gitlabRepo gitlabHost githubToken gitlabToken"
  ).lean();
  if (!project) return null;

  const finished = (await projectStatusHistories(db, projectId))
    .filter((t) => !t.archived && t.role === "done" && t.history.kind === "recorded" && within(t.history.finishedAt, window))
    .slice(0, MAX_TASKS);
  const details = await db.Task.find(
    { project: projectId, _id: { $in: finished.map((t) => t.taskId) } },
    "_id description linkedPRs"
  ).lean<{ _id: unknown; description?: string; linkedPRs?: { title: string; url: string; mergedAt?: Date | null }[] }[]>();
  const byId = new Map(details.map((d) => [String(d._id), d]));

  let pullRequestsWithoutTask: PullRequest[] = [];
  let repositoryUnread: string | null = null;
  try {
    pullRequestsWithoutTask = await unclaimedMerges(project as never, db.organisation, window);
  } catch (err) {
    repositoryUnread = err instanceof Error ? err.message : "the repository could not be read";
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    tasks: finished.map((t) => {
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
    pullRequestsWithoutTask,
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
  return gatewayWrite(db, { ...context, source: "release_notes" }, { instructions: releaseNoteInstructions(tone), data: material });
}
