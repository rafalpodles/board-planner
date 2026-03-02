"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const api = useApi();
  const router = useRouter();

  useEffect(() => {
    api
      .get("/api/projects")
      .then(setProjects)
      .catch(console.error)
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
        <Button onClick={() => router.push("/projects/new")}>
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <p className="mb-4">No projects yet</p>
          <Button onClick={() => router.push("/projects/new")}>
            Create your first project
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Card
              key={project._id}
              onClick={() => router.push(`/projects/${project._id}`)}
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
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
