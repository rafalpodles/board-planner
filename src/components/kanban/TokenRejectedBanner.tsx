"use client";

import Link from "next/link";
import type { ApiProject } from "@/types";
import { connectionHealth, formatDay } from "@/lib/connection-health";
import { projectPath } from "@/lib/urls";

/** Only someone who can change the token is told; for anyone else it is a sentence with no action. */
export function TokenRejectedBanner({ project }: { project: ApiProject }) {
  if (!project.canAdmin) return null;
  const stopped = [
    { name: "GitHub", requests: "Pull requests", set: project.githubTokenSet, health: connectionHealth(project.githubConnection) },
    { name: "GitLab", requests: "Merge requests", set: project.gitlabTokenSet, health: connectionHealth(project.gitlabConnection) },
  ].find((p) => p.set && (p.health.state === "rejected" || p.health.state === "expired"));
  if (!stopped) return null;
  const since = stopped.health.state === "rejected" ? stopped.health.since : stopped.health.state === "expired" ? stopped.health.on : null;
  const why = stopped.health.state === "rejected" ? `${stopped.name} rejected the token` : `the ${stopped.name} token expired`;

  return (
    <div
      role="status"
      className="mx-3 mt-3 sm:mx-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
    >
      <span>
        {stopped.requests} on this board stopped updating{since ? ` on ${formatDay(since)}` : ""}: {why}.
      </span>
      <Link
        href={`${projectPath(project.key)}/settings?section=integrations`}
        className="focus-ring shrink-0 rounded font-medium text-primary underline"
      >
        Fix in Settings
      </Link>
    </div>
  );
}
