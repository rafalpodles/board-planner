"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { TaskSurface } from "@/components/tasks/task-surface";

export default function TaskDetailModal() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const router = useRouter();
  const [title, setTitle] = useState("");

  // `bare`: the detail view draws its own top bar, and the modal chrome would double it
  return (
    <Modal open onClose={() => router.back()} title={title} size="xl" bare>
      <TaskSurface value="modal">
        <TaskDetail
          projectId={projectId}
          taskId={taskId}
          onClose={() => router.back()}
          onLoaded={(task, project) => setTitle(`${project.key}-${task.taskNumber}`)}
        />
      </TaskSurface>
    </Modal>
  );
}
