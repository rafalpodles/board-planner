"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import {
  ApiWebhook,
  ApiNotificationChannel,
  WEBHOOK_EVENTS,
  NOTIFICATION_CHANNEL_TYPES,
  NotificationChannelType,
  WebhookEvent,
} from "@/types";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { SettingsCard, EmptyState } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

export function IntegrationsSection({ projectId, project, patchProject, replaceProject }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const github = useDraft({ githubRepo: project.githubRepo || "", githubToken: "" });
  const gitlab = useDraft({
    gitlabRepo: project.gitlabRepo || "",
    gitlabHost: project.gitlabHost || "https://gitlab.com",
    gitlabToken: "",
  });

  const [githubSyncing, setGithubSyncing] = useState(false);
  const [gitlabSyncing, setGitlabSyncing] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newChannelType, setNewChannelType] = useState<NotificationChannelType>("slack");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");

  function fail(err: unknown, fallback: string) {
    toast(err instanceof Error ? err.message : fallback, "error");
  }

  useDirtyGroup(
    { id: "integrations-github", section: "integrations", label: "Integrations · GitHub", count: github.count },
    {
      save: async () => {
        try {
          const payload: Record<string, string> = { githubRepo: github.value.githubRepo.trim() };
          if (github.value.githubToken.trim()) payload.githubToken = github.value.githubToken.trim();
          const updated = await replaceAndReturn(payload);
          github.commit({ githubRepo: updated.githubRepo || "", githubToken: "" });
          toast("GitHub settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save GitHub settings");
        }
      },
      discard: github.discard,
    }
  );

  useDirtyGroup(
    { id: "integrations-gitlab", section: "integrations", label: "Integrations · GitLab", count: gitlab.count },
    {
      save: async () => {
        try {
          const payload: Record<string, string> = {
            gitlabRepo: gitlab.value.gitlabRepo.trim(),
            gitlabHost: gitlab.value.gitlabHost.trim(),
          };
          if (gitlab.value.gitlabToken.trim()) payload.gitlabToken = gitlab.value.gitlabToken.trim();
          const updated = await replaceAndReturn(payload);
          gitlab.commit({
            gitlabRepo: updated.gitlabRepo || "",
            gitlabHost: updated.gitlabHost || "https://gitlab.com",
            gitlabToken: "",
          });
          toast("GitLab settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save GitLab settings");
        }
      },
      discard: gitlab.discard,
    }
  );

  async function replaceAndReturn(payload: Record<string, string>) {
    const updated = await api.put(`/api/projects/${projectId}`, payload);
    replaceProject(updated);
    return updated;
  }

  async function addWebhook() {
    if (!newWebhookUrl.trim()) return;
    try {
      const webhooks: ApiWebhook[] = await api.post(`/api/projects/${projectId}/webhooks`, {
        url: newWebhookUrl.trim(),
      });
      patchProject({ webhooks });
      setNewWebhookUrl("");
      toast("Webhook added", "success");
    } catch (err) {
      fail(err, "Failed to add webhook");
    }
  }

  async function updateWebhook(webhookId: string, patch: Record<string, unknown>) {
    try {
      patchProject({
        webhooks: await api.put(`/api/projects/${projectId}/webhooks`, { webhookId, ...patch }),
      });
    } catch (err) {
      fail(err, "Failed to update webhook");
    }
  }

  async function removeWebhook(webhookId: string) {
    try {
      patchProject({ webhooks: await api.del(`/api/projects/${projectId}/webhooks`, { webhookId }) });
    } catch (err) {
      fail(err, "Failed to remove webhook");
    }
  }

  async function addChannel() {
    if (!newChannelName.trim() || !newChannelUrl.trim()) return;
    try {
      const notificationChannels: ApiNotificationChannel[] = await api.post(
        `/api/projects/${projectId}/notifications`,
        { type: newChannelType, name: newChannelName.trim(), webhookUrl: newChannelUrl.trim() }
      );
      patchProject({ notificationChannels });
      setNewChannelName("");
      setNewChannelUrl("");
      toast("Channel added", "success");
    } catch (err) {
      fail(err, "Failed to add channel");
    }
  }

  async function updateChannel(channelId: string, patch: Record<string, unknown>) {
    try {
      patchProject({
        notificationChannels: await api.put(`/api/projects/${projectId}/notifications`, {
          channelId,
          ...patch,
        }),
      });
    } catch (err) {
      fail(err, "Failed to update channel");
    }
  }

  async function removeChannel(channelId: string) {
    try {
      patchProject({
        notificationChannels: await api.del(`/api/projects/${projectId}/notifications`, { channelId }),
      });
    } catch (err) {
      fail(err, "Failed to remove channel");
    }
  }

  function toggleEvent(current: WebhookEvent[], event: WebhookEvent) {
    return current.includes(event) ? current.filter((e) => e !== event) : [...current, event];
  }

  return (
    <>
      <SettingsCard
        title="GitHub"
        contract="draft"
        status={{ label: project.githubTokenSet ? "Connected" : "Not connected", on: !!project.githubTokenSet }}
        description="Links pull requests to tasks by task key in the branch name or PR title."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Repository"
            value={github.value.githubRepo}
            dirty={github.isDirty("githubRepo")}
            onChange={(e) => github.set("githubRepo", e.target.value)}
            placeholder="owner/repo"
          />
          <div>
            <Input
              label="Access token"
              type="password"
              value={github.value.githubToken}
              dirty={github.isDirty("githubToken")}
              onChange={(e) => github.set("githubToken", e.target.value)}
              placeholder={
                project.githubTokenSet ? "Set — enter a new token to replace" : "ghp_... (fine-grained or classic)"
              }
            />
            <p className="mt-1 text-xs text-text-muted">
              Needs <code>repo</code> scope (read access to pull requests).
            </p>
          </div>
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
                    `Synced: ${result.prsLinked} PRs linked to ${result.tasksLinked} tasks${
                      result.autoTransitioned > 0 ? `, ${result.autoTransitioned} auto-transitioned` : ""
                    }`,
                    "success"
                  );
                } catch (err) {
                  fail(err, "Sync failed");
                } finally {
                  setGithubSyncing(false);
                }
              }}
            >
              {githubSyncing ? "Syncing..." : "Sync pull requests now"}
            </Button>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="GitLab"
        contract="draft"
        status={{ label: project.gitlabTokenSet ? "Connected" : "Not connected", on: !!project.gitlabTokenSet }}
        description="Same matching as GitHub, for merge requests."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Project"
            value={gitlab.value.gitlabRepo}
            dirty={gitlab.isDirty("gitlabRepo")}
            onChange={(e) => gitlab.set("gitlabRepo", e.target.value)}
            placeholder="group/project"
          />
          <Input
            label="Host"
            value={gitlab.value.gitlabHost}
            dirty={gitlab.isDirty("gitlabHost")}
            onChange={(e) => gitlab.set("gitlabHost", e.target.value)}
            placeholder="https://gitlab.com (or your self-hosted instance)"
          />
        </div>
        <Input
          label="Access token"
          type="password"
          value={gitlab.value.gitlabToken}
          dirty={gitlab.isDirty("gitlabToken")}
          onChange={(e) => gitlab.set("gitlabToken", e.target.value)}
          placeholder={
            project.gitlabTokenSet ? "Set — enter a new token to replace" : "glpat-... (needs read_api scope)"
          }
        />
        <div className="flex flex-wrap gap-2">
          {project.gitlabTokenSet && project.gitlabRepo && (
            <Button
              size="sm"
              variant="secondary"
              disabled={gitlabSyncing}
              onClick={async () => {
                setGitlabSyncing(true);
                try {
                  const result = await api.post(`/api/projects/${projectId}/gitlab/sync`, {});
                  toast(
                    `Synced: ${result.prsLinked} MRs linked to ${result.tasksLinked} tasks${
                      result.autoTransitioned > 0 ? `, ${result.autoTransitioned} auto-transitioned` : ""
                    }`,
                    "success"
                  );
                } catch (err) {
                  fail(err, "Sync failed");
                } finally {
                  setGitlabSyncing(false);
                }
              }}
            >
              {gitlabSyncing ? "Syncing..." : "Sync merge requests now"}
            </Button>
          )}
          {(project.gitlabTokenSet || project.gitlabRepo) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  replaceProject(
                    await api.put(`/api/projects/${projectId}`, {
                      gitlabRepo: "",
                      gitlabHost: "https://gitlab.com",
                      gitlabToken: "",
                    })
                  );
                  gitlab.commit({ gitlabRepo: "", gitlabHost: "https://gitlab.com", gitlabToken: "" });
                  toast("GitLab disconnected", "success");
                } catch (err) {
                  fail(err, "Failed to disconnect GitLab");
                }
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Slack & Discord"
        contract="live"
        description="Posts a formatted message to a channel when something happens on the board."
      >
        <div className="space-y-3">
          {(project.notificationChannels || []).map((ch) => (
            <div key={ch._id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      ch.type === "slack"
                        ? "bg-purple-500/10 text-purple-500"
                        : "bg-indigo-500/10 text-indigo-500"
                    }`}
                  >
                    {ch.type === "slack" ? "Slack" : "Discord"}
                  </span>
                  <span className="text-sm font-medium">{ch.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateChannel(ch._id, { enabled: !ch.enabled })}
                    className={`rounded px-2 py-0.5 text-xs ${
                      ch.enabled ? "bg-green-500/10 text-green-500" : "bg-bg-input text-text-muted"
                    }`}
                  >
                    {ch.enabled ? "Active" : "Disabled"}
                  </button>
                  <button
                    onClick={() => removeChannel(ch._id)}
                    className="text-xs text-text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <code className="mb-2 block truncate rounded bg-bg-input px-2 py-0.5 text-xs text-text-muted">
                {ch.webhookUrl}
              </code>
              <div className="flex flex-wrap gap-1">
                {WEBHOOK_EVENTS.map((evt) => (
                  <button
                    key={evt}
                    onClick={() => updateChannel(ch._id, { events: toggleEvent(ch.events, evt) })}
                    className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
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
            <EmptyState>No channels yet. Add one to get board updates in Slack or Discord.</EmptyState>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              value={newChannelType}
              onChange={(e) => setNewChannelType(e.target.value as NotificationChannelType)}
              className="rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
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
              placeholder={
                newChannelType === "slack"
                  ? "https://hooks.slack.com/services/..."
                  : "https://discord.com/api/webhooks/..."
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChannel();
                }
              }}
            />
            <Button variant="secondary" onClick={addChannel}>
              Add
            </Button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Webhooks"
        contract="live"
        description="Raw HTTP POST to your own endpoint when an event fires."
      >
        <div className="space-y-3">
          {(project.webhooks || []).map((wh) => (
            <div key={wh._id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <code className="max-w-[300px] truncate rounded bg-bg-input px-2 py-0.5 text-xs">
                  {wh.url}
                </code>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateWebhook(wh._id, { enabled: !wh.enabled })}
                    className={`rounded px-2 py-0.5 text-xs ${
                      wh.enabled ? "bg-green-500/10 text-green-500" : "bg-bg-input text-text-muted"
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
                    onClick={() => updateWebhook(wh._id, { events: toggleEvent(wh.events, evt) })}
                    className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
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
            <EmptyState>No webhooks yet. Add a URL to receive board events as JSON.</EmptyState>
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
          <Button variant="secondary" onClick={addWebhook}>
            Add
          </Button>
        </div>
      </SettingsCard>
    </>
  );
}
