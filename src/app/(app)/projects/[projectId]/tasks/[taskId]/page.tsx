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
  // `overflow-clip`, never `overflow-hidden`: hidden makes this card a scrollport, and a
  // scrollport that cannot scroll strands everything sticky inside it — the phone's comment
  // bar at the page's very bottom, and the task's own top bar off the top. Clip rounds the
  // property rail's corner without claiming the sticky elements.
  return (
    <div
      // -1.5rem cancels the scrolling <main>'s own py-6, which the task's sticky bar would
      // otherwise leave as a gap with the task scrolling through it
      className="mx-auto w-full max-w-[1240px] shrink-0 overflow-clip rounded-2xl border
        border-border bg-bg-card [--task-bar-top:-1.5rem]"
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
