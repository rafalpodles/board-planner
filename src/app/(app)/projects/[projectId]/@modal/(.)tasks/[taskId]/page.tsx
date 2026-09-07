"use client";

import { useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { projectRefFromPathname, taskRefFromPathname } from "@/lib/urls";

export default function TaskDetailModal() {
  const params = useParams<{ projectId: string; taskId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [title, setTitle] = useState("");

  // Both halves of the task's identity from one source. `useParams` gives the project of the
  // layout this modal was intercepted into — the project being *left* when the URL names another
  // one — so the modal asked for that board's task under this board's address, and drew a task
  // nobody had asked for (BP-540). Nothing reaches here cross-project any more; this is so the
  // answer is still right if something ever does.
  const taskId = taskRefFromPathname(pathname);

  // A soft navigation keeps an unmatched parallel slot's active subpage — Next says so under
  // "Behavior" in parallel-routes — and `default.tsx` only answers a hard load. So leaving the task
  // for anything that is not a task (a project from ⌘K, a sidebar link, the breadcrumb) left this
  // modal parked over whatever arrived (BP-541).
  //
  // Read from the address on every render rather than closed once: a flag would be cleared by the
  // navigation and re-armed by the slot's remembered state, which is why BP-521 says hiding is not
  // a fix. The URL cannot go stale — when it no longer names a task, this slot has nothing to draw.
  if (!taskId) return null;

  const projectId = projectRefFromPathname(pathname) ?? params.projectId;

  // `bare`: the detail view draws its own top bar, and the modal chrome would double it
  return (
    <Modal open onClose={() => router.back()} title={title} size="xl" bare>
      <TaskDetail
        projectId={projectId}
        taskId={taskId}
        onClose={() => router.back()}
        onLoaded={(task, project) => setTitle(`${project.key}-${task.taskNumber}`)}
      />
    </Modal>
  );
}
