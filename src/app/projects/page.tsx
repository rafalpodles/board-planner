"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { ApiProject } from "@/types";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/hooks/use-auth";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const api = useApi();
  const { toast } = useToast();
  const { isAdmin } = useAuth();

  useEffect(() => {
    api
      .get("/api/projects")
      .then(setProjects)
      .catch(() => toast("Failed to load projects", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        {isAdmin && (
          <Link href="/projects/new">
            <Button>New Project</Button>
          </Link>
        )}
      </div>

      {projects.length === 0 ? (
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
              href={`/projects/${project._id}`}
              className="rounded-xl border border-border bg-bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-start justify-between mb-2">
                <h2 className="font-semibold text-lg">{project.name}</h2>
                <span className="text-xs font-mono bg-bg-input px-2 py-1 rounded">
                  {project.key}
                </span>
              </div>
              {project.description && (
                <p className="text-sm text-text-muted line-clamp-2">
                  {project.description}
                </p>
              )}
              {project.components.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {project.components.map((c) => (
                    <span
                      key={c}
                      className="text-xs bg-bg-input px-2 py-0.5 rounded"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
