"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { DEFAULT_PROJECT_ICON } from "@/types";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/hooks/use-auth";
import { useProjects } from "@/hooks/use-projects";
import { projectPath } from "@/lib/urls";
import { PageHeader } from "@/components/shell/PageHeader";
import { LoadFailed } from "@/components/ui/LoadFailed";

export default function ProjectsPage() {
  const { projects, isLoading: loading, loadFailed, retrying, reload } = useProjects();
  const { isAdmin } = useAuth();

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle={
          loadFailed
            ? undefined
            : projects.length === 1
              ? "1 project"
              : `${projects.length} projects`
        }
        actions={
          isAdmin ? (
            <Link href="/projects/new">
              <Button size="sm">New Project</Button>
            </Link>
          ) : undefined
        }
      />

      {loadFailed ? (
        <LoadFailed
          message="Your boards could not be loaded."
          onRetry={reload}
          busy={retrying}
          testId="projects-load-failed"
        />
      ) : projects.length === 0 && !isAdmin ? (
        <NotOnAnyBoard />
      ) : projects.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <p className="mb-4">No projects yet</p>
          {isAdmin && (
            <Link href="/projects/new">
              <Button>Create your first project</Button>
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Link
              key={project._id}
              href={projectPath(project.key)}
              className="rounded-xl border border-border bg-bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <h2 className="font-semibold text-lg flex items-center gap-2 min-w-0">
                  <span
                    className="text-xl leading-none shrink-0"
                    aria-hidden="true"
                  >
                    {project.icon || DEFAULT_PROJECT_ICON}
                  </span>
                  <span className="truncate">{project.name}</span>
                </h2>
                <span className="text-xs font-mono bg-bg-input px-2 py-1 rounded shrink-0">
                  {project.key}
                </span>
              </div>
              {project.description && (
                <p className="text-sm text-text-muted line-clamp-2">
                  {project.description}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NotOnAnyBoard() {
  const api = useApi();
  const [admins, setAdmins] = useState<string[] | "unknown" | null>(null);

  useEffect(() => {
    api
      .get("/api/users/admins")
      .then((list: { fullName: string }[]) => setAdmins(list.map((admin) => admin.fullName)))
      .catch(() => setAdmins("unknown"));
  }, [api]);

  return (
    <div
      className="mx-auto max-w-md py-12 text-center text-text-muted"
      data-testid="not-on-any-board"
      data-admins={admins === "unknown" ? "unknown" : admins ? "named" : "pending"}
    >
      <p className="mb-2 font-medium text-text">You are not on any board yet.</p>
      <p>
        Boards are opened to you by their owners.
        {Array.isArray(admins) && admins.length > 0 && (
          <>
            {" "}
            Ask one of the admins: <span className="text-text">{admins.join(", ")}</span>.
          </>
        )}
      </p>
    </div>
  );
}
