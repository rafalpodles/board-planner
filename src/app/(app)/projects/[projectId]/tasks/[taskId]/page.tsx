"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiProject, ApiTask } from "@/types";
import { useCanonicalUrl } from "@/hooks/use-canonical-url";
import { projectPath } from "@/lib/urls";
import { TaskDetail } from "@/components/tasks/TaskDetail";

export default function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const router = useRouter();
  const [loaded, setLoaded] = useState<{ task: ApiTask; project: ApiProject } | null>(null);

  useCanonicalUrl(loaded?.project.key, loaded?.task.taskNumber);

  // The same card the intercepting modal draws, so both routes render one view.
  // `shrink-0`: the card is a flex child of a scrolling <main>, and without it the card
  // is squeezed to the viewport and the rest of the task is unreachable.
  // The clipping is `lg:` only: an overflow-hidden ancestor becomes the scrollport for
  // anything sticky inside it, which would strand the phone's comment bar at the very
  // bottom of the page. Above lg the bar is hidden, so the clip is free there.
  return (
    <div className="mx-auto w-full max-w-[1240px] shrink-0 rounded-2xl border border-border bg-bg-card lg:overflow-hidden">
      <TaskDetail
        projectId={projectId}
        taskId={taskId}
        onClose={() => router.push(projectPath(projectId))}
        onLoaded={(task, project) => setLoaded({ task, project })}
      />
    </div>
  );
}
