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
  const projectId = projectRefFromPathname(pathname) ?? params.projectId;
  const taskId = taskRefFromPathname(pathname) ?? params.taskId;

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
