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
  ApiTaskTemplate,
  ApiSprint,
  ApiChecklistItem,
  RecurrenceFrequency,
  TaskStatus,
  Difficulty,
  Category,
  TASK_STATUSES,
  STATUS_LABELS,
  DIFFICULTIES,
  CATEGORIES,
} from "@/types";
import { parseChecklistString } from "@/lib/checklist";
import type { GeneratedTask } from "@/lib/ai";

interface TaskFormProps {
  projectId: string;
  projectKey?: string;
  task?: ApiTask;
  components: string[];
  projectLabels?: ApiLabel[];
  taskTemplates?: ApiTaskTemplate[];
  sprints?: ApiSprint[];
  onSaved: () => void;
  onCancel: () => void;
}

export function TaskForm({
  projectId,
  projectKey,
  task,
  components,
  projectLabels = [],
  taskTemplates = [],
  sprints = [],
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
  const [dueDate, setDueDate] = useState(
    task?.dueDate ? task.dueDate.substring(0, 10) : ""
  );
  const [checklist, setChecklist] = useState<{ text: string; done: boolean }[]>(
    task?.checklist || []
  );
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>(
    task?.labels || []
  );
  const [sprint, setSprint] = useState(task?.sprint || "");
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceFrequency | "">(
    task?.recurrence?.frequency || ""
  );
  const [recurrenceInterval, setRecurrenceInterval] = useState(
    task?.recurrence?.interval || 1
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
      setChecklist(parseChecklistString(result.acceptanceCriteria || ""));
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
      dueDate: dueDate || null,
      checklist,
      labels: selectedLabels,
      sprint: sprint || null,
      recurrence: recurrenceFreq
        ? { frequency: recurrenceFreq, interval: recurrenceInterval }
        : null,
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
      {!task && taskTemplates.length > 0 && (
        <Select
          label="Template"
          value=""
          onChange={(e) => {
            const tpl = taskTemplates.find((t) => t._id === e.target.value);
            if (tpl) {
              if (tpl.title) setTitle(tpl.title);
              if (tpl.description) setDescription(tpl.description);
              setDifficulty(tpl.difficulty);
              setCategory(tpl.category);
              if (tpl.component) setComponent(tpl.component);
              if (tpl.acceptanceCriteria) setChecklist(parseChecklistString(tpl.acceptanceCriteria));
            }
          }}
          options={taskTemplates.map((t) => ({ value: t._id, label: t.name }))}
          placeholder="Select a template..."
        />
      )}

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        <div>
          <label className="block text-sm font-medium mb-1">Due Date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Repeats"
          value={recurrenceFreq}
          onChange={(e) => setRecurrenceFreq(e.target.value as RecurrenceFrequency | "")}
          options={[
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ]}
          placeholder="No recurrence"
        />
        {recurrenceFreq && (
          <div>
            <label className="block text-sm font-medium mb-1">Every</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                value={recurrenceInterval}
                onChange={(e) => setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-20 bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="text-sm text-text-muted">
                {recurrenceFreq === "daily" ? "day(s)" : recurrenceFreq === "weekly" ? "week(s)" : "month(s)"}
              </span>
            </div>
          </div>
        )}
      </div>

      {sprints.length > 0 && (
        <Select
          label="Sprint"
          value={sprint}
          onChange={(e) => setSprint(e.target.value)}
          options={sprints
            .filter((s) => s.status !== "completed")
            .map((s) => ({ value: s._id, label: `${s.name}${s.status === "active" ? " (Active)" : ""}` }))}
          placeholder="No sprint (backlog)"
        />
      )}

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

      <div>
        <label className="block text-sm font-medium mb-1">Checklist</label>
        <div className="space-y-1 mb-2">
          {checklist.map((item, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() =>
                  setChecklist((prev) =>
                    prev.map((it, idx) =>
                      idx === i ? { ...it, done: !it.done } : it
                    )
                  )
                }
                className="rounded border-border"
              />
              <input
                type="text"
                value={item.text}
                onChange={(e) =>
                  setChecklist((prev) =>
                    prev.map((it, idx) =>
                      idx === i ? { ...it, text: e.target.value } : it
                    )
                  )
                }
                className="flex-1 bg-transparent border-b border-transparent focus:border-border text-sm py-0.5 focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  setChecklist((prev) => prev.filter((_, idx) => idx !== i))
                }
                className="text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity text-xs min-w-[24px] min-h-[24px]"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newChecklistItem}
            onChange={(e) => setNewChecklistItem(e.target.value)}
            placeholder="Add checklist item..."
            className="flex-1 bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newChecklistItem.trim()) {
                e.preventDefault();
                setChecklist((prev) => [
                  ...prev,
                  { text: newChecklistItem.trim(), done: false },
                ]);
                setNewChecklistItem("");
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              if (newChecklistItem.trim()) {
                setChecklist((prev) => [
                  ...prev,
                  { text: newChecklistItem.trim(), done: false },
                ]);
                setNewChecklistItem("");
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>

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
