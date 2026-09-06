"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiProject, ApiTask } from "@/types";
import { useCanonicalUrl } from "@/hooks/use-canonical-url";
import { projectPath } from "@/lib/urls";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { useDeclareTaskPage } from "@/hooks/use-open-task";

export default function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const router = useRouter();
  const [loaded, setLoaded] = useState<{ task: ApiTask; project: ApiProject } | null>(null);

  useCanonicalUrl(loaded?.project.key, loaded?.task.taskNumber);
  useDeclareTaskPage();

  return (
    <div
      className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col overflow-clip
        rounded-2xl border border-border bg-bg-card"
    >
      <TaskDetail
        projectId={projectId}
        taskId={taskId}
        onClose={() => router.push(projectPath(projectId))}
        onLoaded={(task, project) => setLoaded({ task, project })}
      />
    </div>
  );
}
