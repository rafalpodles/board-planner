"use client";

import { useState, useCallback, FormEvent, useEffect, type CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  ApiUser,
  ApiTaskTemplate,
  ApiSprint,
  ApiCustomField,
  RecurrenceFrequency,
  TaskStatus,
  Priority,
  Category,
  ApiProjectColumn,
  PRIORITIES,
  PRIORITY_LABELS,
  CATEGORIES,
} from "@/types";
import { effectiveColumns } from "@/lib/columns";
import { parseChecklistString } from "@/lib/checklist";
import { activeFields, sortedFields, orderedOptions } from "@/lib/custom-fields";
import type { GeneratedTask } from "@/lib/ai";

/**
 * Creates a task. An existing one is edited in place by the detail view, which owns
 * the autosave — see `detail/useTaskEditor`.
 */
interface TaskFormProps {
  projectId: string;
  projectKey?: string;
  categories?: string[];
  columns?: ApiProjectColumn[];
  taskTemplates?: ApiTaskTemplate[];
  sprints?: ApiSprint[];
  /** Pre-selects a sprint on the new task */
  defaultSprint?: string;
  customFields?: ApiCustomField[];
  onSaved: () => void;
  // When set, the created task is linked as this task's child
  parentTaskId?: string;
  onCancel: () => void;
}

export function TaskForm({
  projectId,
  projectKey,
  categories = [],
  columns,
  taskTemplates = [],
  sprints = [],
  defaultSprint = "",
  customFields = [],
  onSaved,
  parentTaskId,
  onCancel,
}: TaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [category, setCategory] = useState<Category>(
    categories.includes("user-story") ? "user-story" : categories[0] || "user-story"
  );
  const formColumns = effectiveColumns(columns);
  const [status, setStatus] = useState<TaskStatus>(
    (formColumns.find((c) => c.role === "backlog")?.id ?? formColumns[0].id) as TaskStatus
  );
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [checklist, setChecklist] = useState<{ text: string; done: boolean }[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [sprint, setSprint] = useState(defaultSprint || "");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>({});
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceFrequency | "">("");
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
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
    api
      .get(`/api/projects/${projectId}/ai/generate-task`)
      .then((res: { enabled: boolean }) => setAiEnabled(res.enabled))
      .catch(() => setAiEnabled(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileUpload = useCallback(
    async (file: File): Promise<string> => {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api.upload("/api/uploads", formData);
      return result.markdown;
    },
    [api]
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
      setCategory(result.category || "user-story");
      setChecklist(parseChecklistString(result.acceptanceCriteria || ""));
      setAiInsights(result);
      toast("Fields filled by AI — review and save", "success");
    } catch {
      toast("AI generation failed", "error");
    } finally {
      setAiLoading(false);
    }
  }

  const body = {
    title,
    description,
    priority,
    category,
    status,
    assignee: assignee || null,
    dueDate: dueDate || null,
    checklist,
    sprint: sprint || null,
    recurrence: recurrenceFreq
      ? { frequency: recurrenceFreq, interval: recurrenceInterval }
      : null,
    customFieldValues,
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const created = await api.post(`/api/projects/${projectId}/tasks`, body);
      if (parentTaskId) {
        try {
          await api.post(`/api/projects/${projectId}/tasks/${parentTaskId}/links`, {
            taskId: created._id,
            type: "parent_of",
          });
        } catch {
          // The task exists by now; reporting a plain failure would invite a
          // second submit and a duplicate
          toast("Task created, but linking it to the parent failed", "error");
        }
      }
      toast("Task created", "success");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {taskTemplates.length > 0 && (
        <Select
          label="Template"
          value=""
          onChange={(e) => {
            const tpl = taskTemplates.find((t) => t._id === e.target.value);
            if (tpl) {
              if (tpl.title) setTitle(tpl.title);
              if (tpl.description) setDescription(tpl.description);
              setCategory(tpl.category);
              if (tpl.acceptanceCriteria) setChecklist(parseChecklistString(tpl.acceptanceCriteria));
            }
          }}
          options={taskTemplates.map((t) => ({ value: t._id, label: t.name }))}
          placeholder="Select a template..."
        />
      )}

      {aiEnabled && (
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
          options={formColumns.map((c) => ({
            value: c.id,
            label: c.label,
          }))}
        />
        <Select
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          options={(categories.length > 0 ? categories : CATEGORIES).map((c) => ({ value: c, label: c }))}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          options={users.map((u) => ({
            value: u.username,
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
            className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm min-h-[44px] focus:outline-none focus:ring-1 focus:ring-primary"
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
                className="w-16 sm:w-20 bg-bg-input border border-border rounded px-3 py-1.5 text-sm min-h-[44px] focus:outline-none focus:ring-1 focus:ring-primary"
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

      {activeFields(customFields).length > 0 && (
        <div className="space-y-3">
          <label className="block text-sm font-medium">Custom Fields</label>
          {sortedFields(activeFields(customFields)).map((field) => {
            const val = customFieldValues[field._id];
            if (field.fieldType === "checkbox") {
              return (
                <label key={field._id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!val}
                    onChange={(e) =>
                      setCustomFieldValues((prev) => ({ ...prev, [field._id]: e.target.checked }))
                    }
                    className="rounded border-border"
                  />
                  {field.name}
                  {field.required && <span className="text-danger">*</span>}
                </label>
              );
            }
            if (field.fieldType === "dropdown") {
              return (
                <Select
                  key={field._id}
                  label={field.name}
                  value={(val as string) || ""}
                  onChange={(e) =>
                    setCustomFieldValues((prev) => ({ ...prev, [field._id]: e.target.value }))
                  }
                  options={orderedOptions(field).map((o) => ({ value: o.id, label: o.value }))}
                  placeholder="Select..."
                  required={field.required}
                />
              );
            }
            if (field.fieldType === "multiselect") {
              const picked = Array.isArray(val) ? (val as string[]) : [];
              return (
                <div key={field._id}>
                  <label className="block text-sm font-medium mb-1">
                    {field.name}
                    {field.required && <span className="text-danger">*</span>}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {orderedOptions(field).map((option) => {
                      const on = picked.includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() =>
                            setCustomFieldValues((prev) => ({
                              ...prev,
                              [field._id]: on
                                ? picked.filter((id) => id !== option.id)
                                : [...picked, option.id],
                            }))
                          }
                          aria-pressed={on}
                          className={`focus-ring chip chip-custom rounded-full px-2.5 py-1 text-xs transition-opacity ${
                            on ? "" : "opacity-40"
                          }`}
                          style={{ "--chip": option.color } as CSSProperties}
                        >
                          {option.value}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <Input
                key={field._id}
                label={field.name}
                type={field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text"}
                value={(val as string) ?? ""}
                onChange={(e) =>
                  setCustomFieldValues((prev) => ({
                    ...prev,
                    [field._id]: field.fieldType === "number" ? (e.target.value ? Number(e.target.value) : "") : e.target.value,
                  }))
                }
                required={field.required}
              />
            );
          })}
        </div>
      )}

      <MarkdownEditor
        label="Description"
        value={description}
        onChange={setDescription}
        onFileUpload={handleFileUpload}
        previewFirst
        placeholder="Markdown supported — use the toolbar, or Cmd/Ctrl+B and Cmd/Ctrl+I"
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

      <div className="flex gap-3 items-center">
        <Button type="submit" disabled={loading}>
          {loading ? "Saving..." : "Create Task"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
