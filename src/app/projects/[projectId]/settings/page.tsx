"use client";

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject, ApiLabel, ApiTaskTemplate, ApiWebhook, ApiProjectAuditLog, DIFFICULTIES, CATEGORIES, WEBHOOK_EVENTS, Difficulty, Category, WebhookEvent } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { toast } = useToast();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [newComponent, setNewComponent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const [aiModel, setAiModel] = useState("");
  const [aiModelSaving, setAiModelSaving] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<ApiTaskTemplate | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [auditLogs, setAuditLogs] = useState<ApiProjectAuditLog[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}`)
      .then((p: ApiProject) => {
        setProject(p);
        setName(p.name);
        setDescription(p.description);
        setGithubRepo(p.githubRepo || "");
      })
      .catch(() => toast("Failed to load project", "error"))
      .finally(() => setLoading(false));
    api
      .get("/api/settings")
      .then((s: { aiModel: string }) => setAiModel(s.aiModel))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const updated = await api.put(`/api/projects/${projectId}`, {
        name,
        description,
        githubRepo,
      });
      setProject(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function addComponent() {
    if (!newComponent.trim()) return;
    try {
      await api.post(`/api/projects/${projectId}/components`, {
        name: newComponent.trim(),
      });
      setProject((p) =>
        p ? { ...p, components: [...p.components, newComponent.trim()] } : p
      );
      setNewComponent("");
    } catch {
      toast("Failed to add component", "error");
    }
  }

  async function removeComponent(comp: string) {
    try {
      await api.del(`/api/projects/${projectId}/components`, { name: comp });
      setProject((p) =>
        p ? { ...p, components: p.components.filter((c) => c !== comp) } : p
      );
    } catch {
      toast("Failed to remove component", "error");
    }
  }

  async function addLabel() {
    if (!newLabelName.trim()) return;
    try {
      const labels: ApiLabel[] = await api.post(`/api/projects/${projectId}/labels`, {
        name: newLabelName.trim(),
        color: newLabelColor,
      });
      setProject((p) => (p ? { ...p, labels } : p));
      setNewLabelName("");
      setNewLabelColor("#3b82f6");
    } catch {
      toast("Failed to add label", "error");
    }
  }

  async function removeLabel(labelId: string) {
    try {
      const labels: ApiLabel[] = await api.del(`/api/projects/${projectId}/labels`, { labelId });
      setProject((p) => (p ? { ...p, labels } : p));
    } catch {
      toast("Failed to remove label", "error");
    }
  }

  async function addTemplate() {
    if (!newTemplateName.trim()) return;
    try {
      const templates: ApiTaskTemplate[] = await api.post(`/api/projects/${projectId}/templates`, {
        name: newTemplateName.trim(),
      });
      setProject((p) => (p ? { ...p, taskTemplates: templates } : p));
      setNewTemplateName("");
    } catch {
      toast("Failed to add template", "error");
    }
  }

  async function removeTemplate(templateId: string) {
    try {
      const templates: ApiTaskTemplate[] = await api.del(`/api/projects/${projectId}/templates`, { templateId });
      setProject((p) => (p ? { ...p, taskTemplates: templates } : p));
    } catch {
      toast("Failed to remove template", "error");
    }
  }

  async function saveTemplate(template: ApiTaskTemplate) {
    try {
      const templates: ApiTaskTemplate[] = await api.put(`/api/projects/${projectId}/templates`, {
        templateId: template._id,
        ...template,
      });
      setProject((p) => (p ? { ...p, taskTemplates: templates } : p));
      setEditingTemplate(null);
      toast("Template saved", "success");
    } catch {
      toast("Failed to save template", "error");
    }
  }

  async function addWebhook() {
    if (!newWebhookUrl.trim()) return;
    try {
      const webhooks: ApiWebhook[] = await api.post(`/api/projects/${projectId}/webhooks`, {
        url: newWebhookUrl.trim(),
      });
      setProject((p) => (p ? { ...p, webhooks } : p));
      setNewWebhookUrl("");
      toast("Webhook added", "success");
    } catch {
      toast("Failed to add webhook", "error");
    }
  }

  async function removeWebhook(webhookId: string) {
    try {
      const webhooks: ApiWebhook[] = await api.del(`/api/projects/${projectId}/webhooks`, { webhookId });
      setProject((p) => (p ? { ...p, webhooks } : p));
    } catch {
      toast("Failed to remove webhook", "error");
    }
  }

  async function toggleWebhook(webhookId: string, enabled: boolean) {
    try {
      const webhooks: ApiWebhook[] = await api.put(`/api/projects/${projectId}/webhooks`, {
        webhookId,
        enabled,
      });
      setProject((p) => (p ? { ...p, webhooks } : p));
    } catch {
      toast("Failed to update webhook", "error");
    }
  }

  async function toggleWebhookEvent(webhookId: string, event: WebhookEvent, currentEvents: WebhookEvent[]) {
    const events = currentEvents.includes(event)
      ? currentEvents.filter((e) => e !== event)
      : [...currentEvents, event];
    try {
      const webhooks: ApiWebhook[] = await api.put(`/api/projects/${projectId}/webhooks`, {
        webhookId,
        events,
      });
      setProject((p) => (p ? { ...p, webhooks } : p));
    } catch {
      toast("Failed to update webhook", "error");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}`);
      router.replace("/projects");
    } catch {
      toast("Failed to delete project", "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <button
        onClick={() => router.push(`/projects/${projectId}`)}
        className="text-sm text-text-muted hover:text-text mb-4 inline-block min-h-[44px] flex items-center"
      >
        &larr; Back to board
      </button>

      <h1 className="text-2xl font-bold mb-6">Project Settings</h1>

      <form onSubmit={handleSave} className="space-y-4 mb-8">
        <Input
          label="Project Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input label="Project Key" value={project.key} disabled />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          label="GitHub Repository"
          value={githubRepo}
          onChange={(e) => setGithubRepo(e.target.value)}
          placeholder="owner/repo (e.g. rafalpodles/claude-planner)"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </form>

      {/* Components */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Components</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {project.components.map((comp) => (
            <span
              key={comp}
              className="inline-flex items-center gap-1 text-sm bg-bg-input px-3 py-1 rounded-full"
            >
              {comp}
              <button
                onClick={() => removeComponent(comp)}
                className="text-text-muted hover:text-danger ml-1 min-w-[24px] min-h-[24px] flex items-center justify-center"
              >
                &times;
              </button>
            </span>
          ))}
          {project.components.length === 0 && (
            <p className="text-sm text-text-muted">No components</p>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={newComponent}
            onChange={(e) => setNewComponent(e.target.value)}
            placeholder="Add component..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addComponent();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={addComponent}>
            Add
          </Button>
        </div>
      </div>

      {/* Labels */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Labels</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {(project.labels || []).map((label) => (
            <span
              key={label._id}
              className="inline-flex items-center gap-1 text-sm px-3 py-1 rounded-full text-white"
              style={{ backgroundColor: label.color }}
            >
              {label.name}
              <button
                onClick={() => removeLabel(label._id)}
                className="hover:opacity-70 ml-1 min-w-[24px] min-h-[24px] flex items-center justify-center"
              >
                &times;
              </button>
            </span>
          ))}
          {(project.labels || []).length === 0 && (
            <p className="text-sm text-text-muted">No labels</p>
          )}
        </div>

        <div className="flex gap-2 items-end">
          <Input
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
            placeholder="Label name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLabel();
              }
            }}
          />
          <input
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
            className="w-10 h-10 rounded border border-border cursor-pointer bg-transparent"
          />
          <Button type="button" variant="secondary" onClick={addLabel}>
            Add
          </Button>
        </div>
      </div>

      {/* Task Templates */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Task Templates</h2>
        <p className="text-sm text-text-muted mb-3">
          Pre-defined templates to quickly create tasks with common settings.
        </p>

        <div className="space-y-2 mb-3">
          {(project.taskTemplates || []).map((tpl) => (
            <div key={tpl._id} className="border border-border rounded-lg p-3">
              {editingTemplate?._id === tpl._id ? (
                <div className="space-y-3">
                  <Input
                    label="Name"
                    value={editingTemplate.name}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                  />
                  <Input
                    label="Title template"
                    value={editingTemplate.title}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })}
                    placeholder="Pre-filled title"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-sm font-medium mb-1">Difficulty</label>
                      <select
                        value={editingTemplate.difficulty}
                        onChange={(e) => setEditingTemplate({ ...editingTemplate, difficulty: e.target.value as Difficulty })}
                        className="w-full text-sm bg-bg-input border border-border rounded-lg px-3 py-2"
                      >
                        {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Category</label>
                      <select
                        value={editingTemplate.category}
                        onChange={(e) => setEditingTemplate({ ...editingTemplate, category: e.target.value as Category })}
                        className="w-full text-sm bg-bg-input border border-border rounded-lg px-3 py-2"
                      >
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>
                  <Input
                    label="Component"
                    value={editingTemplate.component}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, component: e.target.value })}
                  />
                  <Textarea
                    label="Description"
                    value={editingTemplate.description}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, description: e.target.value })}
                    rows={3}
                  />
                  <Textarea
                    label="Acceptance Criteria"
                    value={editingTemplate.acceptanceCriteria}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, acceptanceCriteria: e.target.value })}
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveTemplate(editingTemplate)}>Save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingTemplate(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-sm">{tpl.name}</span>
                    <span className="text-xs text-text-muted ml-2">
                      {tpl.category} &middot; {tpl.difficulty}
                      {tpl.component ? ` · ${tpl.component}` : ""}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setEditingTemplate({ ...tpl })}
                      className="text-xs text-text-muted hover:text-text px-2 py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => removeTemplate(tpl._id)}
                      className="text-xs text-text-muted hover:text-danger px-2 py-1"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {(project.taskTemplates || []).length === 0 && (
            <p className="text-sm text-text-muted">No templates</p>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="Template name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTemplate();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={addTemplate}>
            Add
          </Button>
        </div>
      </div>

      {/* AI Model */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">AI Model</h2>
        <p className="text-sm text-text-muted mb-3">
          OpenAI model used for AI task generation (e.g. gpt-4o-mini, gpt-4o, gpt-4.1-mini).
        </p>
        <div className="flex gap-2">
          <Input
            value={aiModel}
            onChange={(e) => setAiModel(e.target.value)}
            placeholder="gpt-4o-mini"
          />
          <Button
            type="button"
            variant="secondary"
            disabled={aiModelSaving}
            onClick={async () => {
              if (!aiModel.trim()) return;
              setAiModelSaving(true);
              try {
                const res = await api.put("/api/settings", { aiModel: aiModel.trim() });
                setAiModel(res.aiModel);
                toast("AI model saved", "success");
              } catch {
                toast("Failed to save AI model", "error");
              } finally {
                setAiModelSaving(false);
              }
            }}
          >
            {aiModelSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Webhooks */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Webhooks</h2>
        <p className="text-sm text-text-muted mb-3">
          Send HTTP POST requests to external URLs when events occur.
        </p>

        <div className="space-y-3 mb-3">
          {(project.webhooks || []).map((wh) => (
            <div key={wh._id} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <code className="text-xs bg-bg-input px-2 py-0.5 rounded truncate max-w-[300px]">
                  {wh.url}
                </code>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleWebhook(wh._id, !wh.enabled)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      wh.enabled
                        ? "bg-green-500/10 text-green-500"
                        : "bg-bg-input text-text-muted"
                    }`}
                  >
                    {wh.enabled ? "Active" : "Disabled"}
                  </button>
                  <button
                    onClick={() => removeWebhook(wh._id)}
                    className="text-xs text-text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {WEBHOOK_EVENTS.map((evt) => (
                  <button
                    key={evt}
                    onClick={() => toggleWebhookEvent(wh._id, evt, wh.events)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                      wh.events.includes(evt)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-text-muted"
                    }`}
                  >
                    {evt.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {(project.webhooks || []).length === 0 && (
            <p className="text-sm text-text-muted">No webhooks configured</p>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={newWebhookUrl}
            onChange={(e) => setNewWebhookUrl(e.target.value)}
            placeholder="https://example.com/webhook"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addWebhook();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={addWebhook}>
            Add
          </Button>
        </div>
      </div>

      {/* Audit Log */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Audit Log</h2>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={async () => {
              if (!showAudit && auditLogs.length === 0) {
                try {
                  const logs = await api.get(`/api/projects/${projectId}/audit`);
                  setAuditLogs(logs);
                } catch {
                  toast("Failed to load audit log", "error");
                }
              }
              setShowAudit((v) => !v);
            }}
          >
            {showAudit ? "Hide" : "Show"}
          </Button>
        </div>

        {showAudit && (
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {auditLogs.length === 0 ? (
              <p className="text-sm text-text-muted">No audit entries</p>
            ) : (
              auditLogs.map((log) => (
                <div
                  key={log._id}
                  className="flex items-start gap-2 text-xs py-1.5 border-b border-border/50 last:border-b-0"
                >
                  <span className="text-text-muted whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                  <span className="font-medium whitespace-nowrap">
                    {typeof log.user === "object" ? log.user.username : "system"}
                  </span>
                  <span className="text-text-muted">
                    {log.action.replace(/_/g, " ")}
                  </span>
                  {log.detail && (
                    <span className="text-text truncate">{log.detail}</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="border-t border-border pt-6">
        <h2 className="font-semibold text-danger mb-3">Danger Zone</h2>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Delete Project
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete Project"
        message={`Are you sure you want to delete "${project.name}" and all its tasks? This action cannot be undone.`}
        confirmLabel="Delete Project"
        loading={deleting}
      />
    </div>
  );
}
