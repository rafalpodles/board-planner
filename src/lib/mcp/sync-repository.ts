import { echo } from "@/lib/echo";
import type { McpProject } from "./planner-client";

const PROVIDER_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/**
 * Which integration to run, from what the board itself says: its repository's host and the token it
 * holds. Refused here, in words about the board, rather than left to the route's "a repository URL and a
 * token must be configured" — and the repository's address is never echoed: a pasted clone URL can carry
 * credentials.
 */
export function syncProvider(project: McpProject, projectKey: string): "github" | "gitlab" {
  const board = echo(projectKey.toUpperCase());
  if (!project.repositoryUrl) {
    throw new Error(
      `${board} has no repository. A project owner sets one, and a token, under Settings → Integrations in the app. Nothing was synced.`
    );
  }
  const provider = project.repositoryProvider;
  if (provider !== "github" && provider !== "gitlab") {
    throw new Error(
      `${board}'s repository is neither on GitHub nor on GitLab, so there is nothing to sync (a self-hosted GitLab also needs its GitLab host set in the app). Nothing was synced.`
    );
  }
  const hasToken = provider === "github" ? project.githubTokenSet : project.gitlabTokenSet;
  if (!hasToken) {
    throw new Error(
      `${board} has no ${PROVIDER_NAMES[provider]} token stored, which reading its ${provider === "github" ? "pull requests" : "merge requests"} needs. A project owner adds one under Settings → Integrations in the app. Nothing was synced.`
    );
  }
  return provider;
}

type Answer = {
  prsFound?: number;
  tasksLinked?: number;
  prsLinked?: number;
  prsUnlinked?: number;
  autoTransitioned?: number;
};

/** What the sync did, in a handful of numbers and a sentence; the route's own counters, nothing from the provider */
export function syncSummary(provider: "github" | "gitlab", answer: Answer) {
  const noun = provider === "github" ? "pull request" : "merge request";
  const found = answer.prsFound ?? 0;
  const linked = answer.prsLinked ?? 0;
  const tasks = answer.tasksLinked ?? 0;
  const unlinked = answer.prsUnlinked ?? 0;
  const moved = answer.autoTransitioned ?? 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const summary =
    found === 0
      ? `No ${noun} names a task of this board (in its branch or title), so there was nothing to refresh.`
      : [
          `Refreshed ${plural(linked, noun)} on ${plural(tasks, "task")}`,
          ...(unlinked > 0 ? [`${plural(unlinked, "stale link")} removed`] : []),
          ...(moved > 0 ? [`${plural(moved, "task")} moved to the next review column because its ${noun} merged`] : []),
        ].join("; ") + ".";

  return {
    provider,
    synced: true,
    matched: found,
    linksRefreshed: linked,
    tasksLinked: tasks,
    linksRemoved: unlinked,
    tasksMoved: moved,
    summary,
  };
}
