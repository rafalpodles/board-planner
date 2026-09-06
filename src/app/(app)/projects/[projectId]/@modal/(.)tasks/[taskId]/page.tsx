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

  const projectId = projectRefFromPathname(pathname) ?? params.projectId;
  const taskId = taskRefFromPathname(pathname) ?? params.taskId;

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
