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
  ApiLabel,
  TaskStatus,
  Difficulty,
  Category,
  TASK_STATUSES,
  STATUS_LABELS,
  DIFFICULTIES,
  CATEGORIES,
} from "@/types";
import type { GeneratedTask } from "@/lib/ai";

interface TaskFormProps {
  projectId: string;
  projectKey?: string;
  task?: ApiTask;
  components: string[];
  projectLabels?: ApiLabel[];
  onSaved: () => void;
  onCancel: () => void;
}

export function TaskForm({
  projectId,
  projectKey,
  task,
  components,
  projectLabels = [],
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
  const [selectedLabels, setSelectedLabels] = useState<string[]>(
    task?.labels || []
  );
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiInsights, setAiInsights] = useState<GeneratedTask | null>(null);
  const api = useApi();
  const { toast } = useToast();

  useEffect(() => {
    api.get("/api/users").then(setUsers).catch(() => toast("Failed to load users", "error"));
    if (!task) {
      api
        .get(`/api/projects/${projectId}/ai/generate-task`)
        .then((res: { enabled: boolean }) => setAiEnabled(res.enabled))
        .catch(() => setAiEnabled(false));
    }
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

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const result: GeneratedTask = await api.post(
        `/api/projects/${projectId}/ai/generate-task`,
        { prompt: aiPrompt.trim() }
      );
      setTitle(result.title || "");
      setDescription(result.description || "");
      setDifficulty(result.difficulty || "M");
      setCategory(result.category || "user-story");
      setComponent(result.component || "");
      setAcceptanceCriteria(result.acceptanceCriteria || "");
      setAiInsights(result);
      toast("Fields filled by AI — review and save", "success");
    } catch {
      toast("AI generation failed", "error");
    } finally {
      setAiLoading(false);
    }
  }

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
      labels: selectedLabels,
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
      {aiEnabled && !task && (
        <div className="bg-bg-input border border-border rounded-lg p-3 space-y-2">
          <label className="text-sm font-medium">AI Assist</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Describe what you need, e.g. 'add dark mode toggle'"
              className="flex-1 bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAiGenerate();
                }
              }}
              disabled={aiLoading}
            />
            <Button
              type="button"
              size="sm"
              onClick={handleAiGenerate}
              disabled={aiLoading || !aiPrompt.trim()}
            >
              {aiLoading ? "Generating..." : "Generate"}
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            AI will fill all fields below. You can edit before saving.
          </p>
        </div>
      )}

      {aiInsights && (
        <div className="space-y-2">
          {aiInsights.duplicateOf && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
              <p className="text-sm font-medium text-danger">
                Possible duplicate of {projectKey}-{aiInsights.duplicateOf}
              </p>
              {aiInsights.duplicateReason && (
                <p className="text-xs text-text-muted mt-1">
                  {aiInsights.duplicateReason}
                </p>
              )}
            </div>
          )}

          {(aiInsights.suggestedBlockedBy.length > 0 ||
            aiInsights.suggestedBlocking.length > 0) && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 space-y-1">
              <p className="text-sm font-medium text-warning">
                Suggested dependencies
              </p>
              {aiInsights.suggestedBlockedBy.length > 0 && (
                <p className="text-xs text-text-muted">
                  Blocked by:{" "}
                  {aiInsights.suggestedBlockedBy
                    .map((n) => `${projectKey}-${n}`)
                    .join(", ")}
                </p>
              )}
              {aiInsights.suggestedBlocking.length > 0 && (
                <p className="text-xs text-text-muted">
                  Would block:{" "}
                  {aiInsights.suggestedBlocking
                    .map((n) => `${projectKey}-${n}`)
                    .join(", ")}
                </p>
              )}
              {aiInsights.dependencyReason && (
                <p className="text-xs text-text-muted mt-1">
                  {aiInsights.dependencyReason}
                </p>
              )}
            </div>
          )}
        </div>
      )}

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

      {projectLabels.length > 0 && (
        <div>
          <label className="block text-sm font-medium mb-1">Labels</label>
          <div className="flex flex-wrap gap-2">
            {projectLabels.map((label) => {
              const isSelected = selectedLabels.includes(label._id);
              return (
                <button
                  key={label._id}
                  type="button"
                  onClick={() =>
                    setSelectedLabels((prev) =>
                      isSelected
                        ? prev.filter((id) => id !== label._id)
                        : [...prev, label._id]
                    )
                  }
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${
                    isSelected
                      ? "text-white border-transparent"
                      : "border-border text-text-muted hover:border-primary/50"
                  }`}
                  style={isSelected ? { backgroundColor: label.color } : undefined}
                >
                  {label.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
