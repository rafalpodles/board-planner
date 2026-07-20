"use client";

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject, ApiLabel, ApiCustomField, ApiTaskTemplate, ApiWebhook, ApiNotificationChannel, ApiProjectAuditLog, DIFFICULTIES, CATEGORIES, WEBHOOK_EVENTS, NOTIFICATION_CHANNEL_TYPES, CUSTOM_FIELD_TYPES, Difficulty, Category, CustomFieldType, WebhookEvent, NotificationChannelType } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

interface McpServerDraft {
  name: string;
  url: string;
  authType: "none" | "bearer" | "oauth";
  authToken: string;
  allowWrites: boolean;
  toolAllowlist: string;
  enabled: boolean;
  hasAuthToken: boolean;
  oauthStatus?: string;
  oauthClientId: string;
  oauthClientSecret: string;
  testing?: boolean;
  testResult?: string;
  connecting?: boolean;
}

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
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState<CustomFieldType>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<ApiTaskTemplate | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newChannelType, setNewChannelType] = useState<NotificationChannelType>("slack");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");
  const [auditLogs, setAuditLogs] = useState<ApiProjectAuditLog[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [githubTokenSaving, setGithubTokenSaving] = useState(false);
  const [githubSyncing, setGithubSyncing] = useState(false);
  const [pmEnabled, setPmEnabled] = useState(false);
  const [pmModel, setPmModel] = useState("");
  const [pmNotes, setPmNotes] = useState("");
  const [pmDailyCap, setPmDailyCap] = useState("");
  const [pmLinks, setPmLinks] = useState<{ label: string; url: string }[]>([]);
  const [newPmLinkLabel, setNewPmLinkLabel] = useState("");
  const [newPmLinkUrl, setNewPmLinkUrl] = useState("");
  const [pmSaving, setPmSaving] = useState(false);
  const [pmMcpServers, setPmMcpServers] = useState<McpServerDraft[]>([]);

  useEffect(() => {
    const oauthResult = new URLSearchParams(window.location.search).get("mcp_oauth");
    if (oauthResult) {
      if (oauthResult === "ok") {
        toast("MCP OAuth connection established", "success");
      } else {
        toast(`MCP OAuth failed: ${oauthResult.replace(/^error:/, "")}`, "error");
      }
      window.history.replaceState(null, "", window.location.pathname);
    }
    api
      .get(`/api/projects/${projectId}`)
      .then((p: ApiProject) => {
        setProject(p);
        setName(p.name);
        setDescription(p.description);
        setGithubRepo(p.githubRepo || "");
        setPmEnabled(p.pm?.enabled || false);
        setPmModel(p.pm?.model || "");
        setPmNotes(p.pm?.contextNotes || "");
        setPmDailyCap(p.pm?.dailyTurnCap ? String(p.pm.dailyTurnCap) : "");
        setPmLinks(p.pm?.links?.map((l) => ({ label: l.label, url: l.url })) || []);
        syncMcpServersFrom(p);
      })
      .catch(() => toast("Failed to load project", "error"))
      .finally(() => setLoading(false));
    api
      .get("/api/settings")
      .then((s: { aiModel: string }) => setAiModel(s.aiModel))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function updateMcpServer(index: number, patch: Partial<McpServerDraft>) {
    setPmMcpServers((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function syncMcpServersFrom(p: ApiProject) {
    setPmMcpServers(
      p.pm?.mcpServers?.map((s) => ({
        name: s.name,
        url: s.url,
        authType: s.authType,
        authToken: "",
        allowWrites: s.allowWrites,
        toolAllowlist: (s.toolAllowlist || []).join(", "),
        enabled: s.enabled,
        hasAuthToken: s.hasAuthToken,
        oauthStatus: s.oauthStatus,
        oauthClientId: s.oauthClientId || "",
        oauthClientSecret: "",
      })) || []
    );
  }

  async function testMcpServer(index: number) {
    const server = pmMcpServers[index];
    updateMcpServer(index, { testing: true, testResult: "" });
    try {
      const res = await api.post(`/api/projects/${projectId}/pm/mcp-test`, {
        name: server.name.trim(),
        url: server.url.trim(),
        authType: server.authType,
        authToken: server.authToken,
      });
      const names = (res.tools || [])
        .map((t: { name: string; readSafe: boolean }) => `${t.name}${t.readSafe ? "" : " (write)"}`)
        .join(", ");
      updateMcpServer(index, { testing: false, testResult: `✓ Connected — ${res.count} tools: ${names || "(none)"}` });
    } catch (err) {
      updateMcpServer(index, { testing: false, testResult: `✗ ${err instanceof Error ? err.message : "Connection failed"}` });
    }
  }

  async function savePmSettings(options?: { silent?: boolean }): Promise<boolean> {
    setPmSaving(true);
    try {
      const updated = await api.put(`/api/projects/${projectId}`, {
        pm: {
          enabled: pmEnabled,
          model: pmModel.trim(),
          contextNotes: pmNotes,
          links: pmLinks,
          dailyTurnCap: pmDailyCap.trim() ? Number(pmDailyCap) : 0,
          mcpServers: pmMcpServers
            .filter((s) => s.name.trim() || s.url.trim())
            .map((s) => ({
              name: s.name.trim(),
              url: s.url.trim(),
              authType: s.authType,
              authToken: s.authToken,
              oauthClientId: s.oauthClientId.trim(),
              oauthClientSecret: s.oauthClientSecret,
              allowWrites: s.allowWrites,
              toolAllowlist: s.toolAllowlist
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              enabled: s.enabled,
            })),
        },
      });
      setProject(updated);
      syncMcpServersFrom(updated);
      if (!options?.silent) toast("PM settings saved", "success");
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save PM settings", "error");
      return false;
    } finally {
      setPmSaving(false);
    }
  }

  async function connectMcpOauth(index: number) {
    const serverName = pmMcpServers[index].name.trim();
    const failByName = (msg: string) =>
      setPmMcpServers((prev) =>
        prev.map((s) =>
          s.name.trim() === serverName ? { ...s, connecting: false, testResult: msg } : s
        )
      );
    updateMcpServer(index, { connecting: true, testResult: "" });
    // Persist the current draft first so Connect works without a manual save
    const saved = await savePmSettings({ silent: true });
    if (!saved) {
      failByName("");
      return;
    }
    try {
      const res = await api.post(`/api/projects/${projectId}/pm/mcp-oauth/start`, {
        name: serverName,
      });
      window.location.href = res.authorizationUrl;
    } catch (err) {
      failByName(`✗ ${err instanceof Error ? err.message : "OAuth start failed"}`);
    }
  }

  async function disconnectMcpOauth(index: number) {
    const server = pmMcpServers[index];
    try {
      await api.post(`/api/projects/${projectId}/pm/mcp-oauth/disconnect`, {
        name: server.name.trim(),
      });
      updateMcpServer(index, { oauthStatus: "unconfigured" });
      toast("OAuth connection removed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Disconnect failed", "error");
    }
  }

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

  async function addCustomField() {
    if (!newFieldName.trim()) return;
    try {
      const fields: ApiCustomField[] = await api.post(`/api/projects/${projectId}/custom-fields`, {
        name: newFieldName.trim(),
        fieldType: newFieldType,
        options: newFieldType === "dropdown" ? newFieldOptions.split(",").map((o) => o.trim()).filter(Boolean) : [],
        required: newFieldRequired,
      });
      setProject((p) => (p ? { ...p, customFields: fields } : p));
      setNewFieldName("");
      setNewFieldOptions("");
      setNewFieldRequired(false);
    } catch {
      toast("Failed to add custom field", "error");
    }
  }

  async function removeCustomField(fieldId: string) {
    try {
      const fields: ApiCustomField[] = await api.del(`/api/projects/${projectId}/custom-fields/${fieldId}`);
      setProject((p) => (p ? { ...p, customFields: fields } : p));
    } catch {
      toast("Failed to remove custom field", "error");
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

  async function addNotificationChannel() {
    if (!newChannelName.trim() || !newChannelUrl.trim()) return;
    try {
      const channels: ApiNotificationChannel[] = await api.post(`/api/projects/${projectId}/notifications`, {
        type: newChannelType,
        name: newChannelName.trim(),
        webhookUrl: newChannelUrl.trim(),
      });
      setProject((p) => (p ? { ...p, notificationChannels: channels } : p));
      setNewChannelName("");
      setNewChannelUrl("");
      toast("Notification channel added", "success");
    } catch {
      toast("Failed to add notification channel", "error");
    }
  }

  async function removeNotificationChannel(channelId: string) {
    try {
      const channels: ApiNotificationChannel[] = await api.del(`/api/projects/${projectId}/notifications`, { channelId });
      setProject((p) => (p ? { ...p, notificationChannels: channels } : p));
    } catch {
      toast("Failed to remove notification channel", "error");
    }
  }

  async function toggleNotificationChannel(channelId: string, enabled: boolean) {
    try {
      const channels: ApiNotificationChannel[] = await api.put(`/api/projects/${projectId}/notifications`, {
        channelId,
        enabled,
      });
      setProject((p) => (p ? { ...p, notificationChannels: channels } : p));
    } catch {
      toast("Failed to update notification channel", "error");
    }
  }

  async function toggleChannelEvent(channelId: string, event: WebhookEvent, currentEvents: WebhookEvent[]) {
    const events = currentEvents.includes(event)
      ? currentEvents.filter((e) => e !== event)
      : [...currentEvents, event];
    try {
      const channels: ApiNotificationChannel[] = await api.put(`/api/projects/${projectId}/notifications`, {
        channelId,
        events,
      });
      setProject((p) => (p ? { ...p, notificationChannels: channels } : p));
    } catch {
      toast("Failed to update notification channel", "error");
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

      {/* GitHub Integration */}
      {project.githubRepo && (
        <div className="mb-8">
          <h2 className="font-semibold mb-3">GitHub Integration</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                Personal Access Token
                {project.githubTokenSet && (
                  <span className="text-xs text-text-muted ml-2">(configured)</span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder={project.githubTokenSet ? "Enter new token to replace..." : "ghp_... (fine-grained or classic)"}
                  className="flex-1 bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <Button
                  size="sm"
                  disabled={!githubToken.trim() || githubTokenSaving}
                  onClick={async () => {
                    setGithubTokenSaving(true);
                    try {
                      await api.put(`/api/projects/${projectId}`, { githubToken: githubToken.trim() });
                      setProject((p) => p ? { ...p, githubTokenSet: true } : p);
                      setGithubToken("");
                      toast("Token saved", "success");
                    } catch {
                      toast("Failed to save token", "error");
                    } finally {
                      setGithubTokenSaving(false);
                    }
                  }}
                >
                  {githubTokenSaving ? "Saving..." : "Save Token"}
                </Button>
              </div>
              <p className="text-xs text-text-muted mt-1">
                Needs <code>repo</code> scope (read access to pull requests).
              </p>
            </div>

            {project.githubTokenSet && (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={githubSyncing}
                  onClick={async () => {
                    setGithubSyncing(true);
                    try {
                      const result = await api.post(`/api/projects/${projectId}/github/sync`, {});
                      toast(
                        `Synced: ${result.prsLinked} PRs linked to ${result.tasksLinked} tasks${result.autoTransitioned > 0 ? `, ${result.autoTransitioned} auto-transitioned` : ""}`,
                        "success"
                      );
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Sync failed", "error");
                    } finally {
                      setGithubSyncing(false);
                    }
                  }}
                >
                  {githubSyncing ? "Syncing..." : "Sync PRs Now"}
                </Button>
                <p className="text-xs text-text-muted mt-1">
                  Fetches PRs and matches them to tasks by key in branch name or PR title.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

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

      {/* Custom Fields */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Custom Fields</h2>
        <p className="text-sm text-text-muted mb-3">
          Define extra fields that appear on all tasks in this project.
        </p>

        <div className="space-y-2 mb-3">
          {(project.customFields || []).map((field) => (
            <div
              key={field._id}
              className="flex items-center justify-between border border-border rounded-lg px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{field.name}</span>
                <span className="text-xs bg-bg-input px-2 py-0.5 rounded text-text-muted">
                  {field.fieldType}
                </span>
                {field.required && (
                  <span className="text-xs text-warning">required</span>
                )}
                {field.fieldType === "dropdown" && field.options.length > 0 && (
                  <span className="text-xs text-text-muted">
                    [{field.options.join(", ")}]
                  </span>
                )}
              </div>
              <button
                onClick={() => removeCustomField(field._id)}
                className="text-xs text-text-muted hover:text-danger px-2 py-1"
              >
                Delete
              </button>
            </div>
          ))}
          {(project.customFields || []).length === 0 && (
            <p className="text-sm text-text-muted">No custom fields</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              placeholder="Field name..."
            />
            <select
              value={newFieldType}
              onChange={(e) => setNewFieldType(e.target.value as CustomFieldType)}
              className="text-sm bg-bg-input border border-border rounded-lg px-3 py-2"
            >
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {newFieldType === "dropdown" && (
            <Input
              value={newFieldOptions}
              onChange={(e) => setNewFieldOptions(e.target.value)}
              placeholder="Options (comma-separated)..."
            />
          )}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={newFieldRequired}
                onChange={(e) => setNewFieldRequired(e.target.checked)}
                className="rounded border-border"
              />
              Required
            </label>
            <Button type="button" variant="secondary" size="sm" onClick={addCustomField}>
              Add Field
            </Button>
          </div>
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

      {/* PM Agent */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">PM Agent</h2>
        {!project.pmAvailable ? (
          <p className="text-sm text-text-muted">
            Set the <code>OPENROUTER_API_KEY</code> environment variable on the server to enable
            the PM agent (optionally <code>PM_MODEL</code> for the default model).
          </p>
        ) : (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={pmEnabled}
                onChange={(e) => setPmEnabled(e.target.checked)}
              />
              Enable the PM agent for this project
            </label>
            <div>
              <label className="block text-sm font-medium mb-1">Model override</label>
              <Input
                value={pmModel}
                onChange={(e) => setPmModel(e.target.value)}
                placeholder="Leave empty to use the server default (PM_MODEL)"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Daily turn cap</label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={pmDailyCap}
                onChange={(e) => setPmDailyCap(e.target.value)}
                placeholder="Leave empty for the server default"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Project context</label>
              <textarea
                value={pmNotes}
                onChange={(e) => setPmNotes(e.target.value)}
                rows={5}
                maxLength={5000}
                placeholder="What this project is, conventions, priorities — injected into the PM's system prompt."
                className="w-full bg-bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Documentation links</label>
              {pmLinks.length > 0 && (
                <ul className="mb-2 space-y-1">
                  {pmLinks.map((link, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{link.label}</span>
                      <span className="text-text-muted truncate flex-1">{link.url}</span>
                      <button
                        type="button"
                        onClick={() => setPmLinks((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-danger hover:opacity-80 cursor-pointer"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input
                  value={newPmLinkLabel}
                  onChange={(e) => setNewPmLinkLabel(e.target.value)}
                  placeholder="Label"
                />
                <Input
                  value={newPmLinkUrl}
                  onChange={(e) => setNewPmLinkUrl(e.target.value)}
                  placeholder="https://..."
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!newPmLinkLabel.trim() || !newPmLinkUrl.trim()}
                  onClick={() => {
                    setPmLinks((prev) => [...prev, { label: newPmLinkLabel.trim(), url: newPmLinkUrl.trim() }]);
                    setNewPmLinkLabel("");
                    setNewPmLinkUrl("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">MCP connections</label>
              <p className="text-xs text-text-muted mb-2">
                External MCP servers the PM agent can read at turn start (e.g. a self-hosted Notion
                MCP). Writes are off unless explicitly allowed per server.
              </p>
              <div className="space-y-3 mb-2">
                {pmMcpServers.map((server, i) => (
                  <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                    <div className="flex gap-2 items-center">
                      <Input
                        value={server.name}
                        onChange={(e) => updateMcpServer(i, { name: e.target.value })}
                        placeholder="name (slug, e.g. notion)"
                        className="max-w-[180px]"
                      />
                      <Input
                        value={server.url}
                        onChange={(e) => updateMcpServer(i, { url: e.target.value })}
                        placeholder="https://mcp.example.com/mcp"
                      />
                      <button
                        type="button"
                        onClick={() => setPmMcpServers((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-danger hover:opacity-80 cursor-pointer"
                        aria-label="Remove MCP server"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="flex gap-2 items-center">
                      <select
                        value={server.authType}
                        onChange={(e) =>
                          updateMcpServer(i, { authType: e.target.value as "none" | "bearer" | "oauth" })
                        }
                        className="bg-bg-input border border-border rounded px-2 py-1.5 text-sm"
                      >
                        <option value="none">No auth</option>
                        <option value="bearer">Bearer token</option>
                        <option value="oauth">OAuth</option>
                      </select>
                      {server.authType === "bearer" && (
                        <Input
                          type="password"
                          value={server.authToken}
                          onChange={(e) => updateMcpServer(i, { authToken: e.target.value })}
                          placeholder={server.hasAuthToken ? "Token set — leave empty to keep" : "Token"}
                        />
                      )}
                      {server.authType === "oauth" && (
                        <>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full border ${
                              server.oauthStatus === "connected"
                                ? "border-success text-success"
                                : server.oauthStatus === "needs_reauth"
                                  ? "border-danger text-danger"
                                  : "border-border text-text-muted"
                            }`}
                          >
                            {server.oauthStatus === "connected"
                              ? "Connected"
                              : server.oauthStatus === "needs_reauth"
                                ? "Needs re-auth"
                                : "Not connected"}
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={server.connecting || !server.name.trim()}
                            onClick={() => connectMcpOauth(i)}
                          >
                            {server.connecting
                              ? "Redirecting..."
                              : server.oauthStatus === "connected"
                                ? "Reconnect"
                                : "Connect"}
                          </Button>
                          {server.oauthStatus === "connected" && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => disconnectMcpOauth(i)}
                            >
                              Disconnect
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                    {server.authType === "oauth" && (
                      <div className="flex gap-2 items-center">
                        <Input
                          value={server.oauthClientId}
                          onChange={(e) => updateMcpServer(i, { oauthClientId: e.target.value })}
                          placeholder="Client ID (optional — auto-registered when supported)"
                        />
                        <Input
                          type="password"
                          value={server.oauthClientSecret}
                          onChange={(e) => updateMcpServer(i, { oauthClientSecret: e.target.value })}
                          placeholder="Client secret (optional)"
                        />
                      </div>
                    )}
                    <Input
                      value={server.toolAllowlist}
                      onChange={(e) => updateMcpServer(i, { toolAllowlist: e.target.value })}
                      placeholder="Tool allowlist, comma-separated (empty = all)"
                    />
                    <div className="flex gap-4 items-center text-sm">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={server.enabled}
                          onChange={(e) => updateMcpServer(i, { enabled: e.target.checked })}
                        />
                        Enabled
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={server.allowWrites}
                          onChange={(e) => updateMcpServer(i, { allowWrites: e.target.checked })}
                        />
                        Allow writes
                      </label>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={server.testing || !server.url.trim()}
                        onClick={() => testMcpServer(i)}
                      >
                        {server.testing ? "Testing..." : "Test connection"}
                      </Button>
                    </div>
                    {server.testResult && (
                      <p className="text-xs text-text-muted whitespace-pre-wrap">{server.testResult}</p>
                    )}
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pmMcpServers.length >= 5}
                onClick={() =>
                  setPmMcpServers((prev) => [
                    ...prev,
                    {
                      name: "",
                      url: "",
                      authType: "none",
                      authToken: "",
                      allowWrites: false,
                      toolAllowlist: "",
                      enabled: true,
                      hasAuthToken: false,
                      oauthClientId: "",
                      oauthClientSecret: "",
                    },
                  ])
                }
              >
                Add MCP server
              </Button>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={pmSaving}
              onClick={() => savePmSettings()}
            >
              {pmSaving ? "Saving..." : "Save PM Settings"}
            </Button>
          </div>
        )}
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

      {/* Notification Channels (Slack/Discord) */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Notifications (Slack / Discord)</h2>
        <p className="text-sm text-text-muted mb-3">
          Send formatted notifications to Slack or Discord channels when events occur.
        </p>

        <div className="space-y-3 mb-3">
          {(project.notificationChannels || []).map((ch) => (
            <div key={ch._id} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    ch.type === "slack"
                      ? "bg-purple-500/10 text-purple-500"
                      : "bg-indigo-500/10 text-indigo-500"
                  }`}>
                    {ch.type === "slack" ? "Slack" : "Discord"}
                  </span>
                  <span className="text-sm font-medium">{ch.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleNotificationChannel(ch._id, !ch.enabled)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      ch.enabled
                        ? "bg-green-500/10 text-green-500"
                        : "bg-bg-input text-text-muted"
                    }`}
                  >
                    {ch.enabled ? "Active" : "Disabled"}
                  </button>
                  <button
                    onClick={() => removeNotificationChannel(ch._id)}
                    className="text-xs text-text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <code className="text-xs bg-bg-input px-2 py-0.5 rounded truncate block mb-2 text-text-muted">
                {ch.webhookUrl}
              </code>
              <div className="flex flex-wrap gap-1">
                {WEBHOOK_EVENTS.map((evt) => (
                  <button
                    key={evt}
                    onClick={() => toggleChannelEvent(ch._id, evt, ch.events)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                      ch.events.includes(evt)
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
          {(project.notificationChannels || []).length === 0 && (
            <p className="text-sm text-text-muted">No notification channels configured</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              value={newChannelType}
              onChange={(e) => setNewChannelType(e.target.value as NotificationChannelType)}
              className="text-sm bg-bg-input border border-border rounded-lg px-3 py-2"
            >
              {NOTIFICATION_CHANNEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "slack" ? "Slack" : "Discord"}
                </option>
              ))}
            </select>
            <Input
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="Channel name..."
            />
          </div>
          <div className="flex gap-2">
            <Input
              value={newChannelUrl}
              onChange={(e) => setNewChannelUrl(e.target.value)}
              placeholder={newChannelType === "slack" ? "https://hooks.slack.com/services/..." : "https://discord.com/api/webhooks/..."}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNotificationChannel();
                }
              }}
            />
            <Button type="button" variant="secondary" onClick={addNotificationChannel}>
              Add
            </Button>
          </div>
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
