"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { TaskDetail } from "@/components/tasks/TaskDetail";

export default function TaskDetailModal() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const router = useRouter();
  const [title, setTitle] = useState("");

  return (
    <Modal open onClose={() => router.back()} title={title} size="xl">
      <TaskDetail
        projectId={projectId}
        taskId={taskId}
        onClose={() => router.back()}
        onLoaded={(task, project) => setTitle(`${project.key}-${task.taskNumber}`)}
      />
    </Modal>
  );
}
