"use client";

import { ApiProject, ApiSprint } from "@/types";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { ALL_TASKS, sprintDefaultForNewTask } from "@/lib/sprint-scope";

interface NewTaskModalProps {
  projectId: string;
  project: ApiProject;
  sprints: ApiSprint[];
  scope: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function NewTaskModal({
  projectId,
  project,
  sprints,
  scope,
  open,
  onClose,
  onSaved,
}: NewTaskModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="New Task" size="lg">
      <TaskForm
        projectId={projectId}
        projectKey={project.key}
        categories={(project.categories || []).map((c) => c.name)}
        columns={project.columns || []}
        taskTemplates={project.taskTemplates || []}
        sprints={sprints}
        defaultSprint={sprintDefaultForNewTask(scope ?? ALL_TASKS)}
        customFields={project.customFields || []}
        onSaved={onSaved}
        onCancel={onClose}
      />
    </Modal>
  );
}
