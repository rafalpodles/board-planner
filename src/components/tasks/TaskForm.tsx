"use client";

import { useState, useCallback, FormEvent, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  ApiTask,
  ApiUser,
  TaskStatus,
  Difficulty,
  Category,
  TASK_STATUSES,
  STATUS_LABELS,
  DIFFICULTIES,
  CATEGORIES,
} from "@/types";

interface TaskFormProps {
  projectId: string;
  task?: ApiTask;
  components: string[];
  onSaved: () => void;
  onCancel: () => void;
}

export function TaskForm({
  projectId,
  task,
  components,
  onSaved,
  onCancel,
}: TaskFormProps) {
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [difficulty, setDifficulty] = useState<Difficulty>(task?.difficulty || "M");
  const [component, setComponent] = useState(task?.component || "");
  const [category, setCategory] = useState<Category>(task?.category || "user-story");
  const [status, setStatus] = useState<TaskStatus>(task?.status || "planned");
  const [assignee, setAssignee] = useState(
    task?.assignee && typeof task.assignee === "object"
      ? task.assignee._id
      : ""
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    task?.acceptanceCriteria || ""
  );
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const api = useApi();
  const { toast } = useToast();

  useEffect(() => {
    api.get("/api/users").then(setUsers).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileUpload = useCallback(
    async (file: File): Promise<string> => {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api.upload("/api/uploads", formData);
      return result.markdown;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const body = {
      title,
      description,
      difficulty,
      component,
      category,
      status,
      assignee: assignee || null,
      acceptanceCriteria,
    };

    try {
      if (task) {
        await api.put(
          `/api/projects/${projectId}/tasks/${task._id}`,
          body
        );
      } else {
        await api.post(`/api/projects/${projectId}/tasks`, body);
      }
      toast(task ? "Task updated" : "Task created", "success");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
          options={TASK_STATUSES.map((s) => ({
            value: s,
            label: STATUS_LABELS[s],
          }))}
        />
        <Select
          label="Difficulty"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as Difficulty)}
          options={DIFFICULTIES.map((d) => ({ value: d, label: d }))}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          options={CATEGORIES.map((c) => ({ value: c, label: c }))}
        />
        <Select
          label="Component"
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          options={components.map((c) => ({ value: c, label: c }))}
          placeholder="None"
        />
      </div>

      <Select
        label="Assignee"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        options={users.map((u) => ({
          value: u._id,
          label: `${u.fullName} (${u.username})`,
        }))}
        placeholder="Unassigned"
      />

      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        onFileUpload={handleFileUpload}
      />

      <Textarea
        label="Acceptance Criteria"
        value={acceptanceCriteria}
        onChange={(e) => setAcceptanceCriteria(e.target.value)}
        rows={4}
        placeholder="- [ ] criterion 1&#10;- [ ] criterion 2"
        onFileUpload={handleFileUpload}
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading}>
          {loading ? "Saving..." : task ? "Update Task" : "Create Task"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
