"use client";

import { useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { timeAgo } from "@/lib/time";
import { useDraft } from "@/hooks/use-draft";
import { CODA_COLUMNS, CODA_KEY_COLUMN } from "@/lib/coda";
import { clearsStoredToken } from "@/lib/host-bound-secrets";
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
import { SecretField } from "@/components/ui/SecretField";
import { SettingRow } from "@/components/settings/SettingRow";
import { diffById } from "@/lib/row-diff";
import { SettingsCard, EmptyState } from "@/components/settings/SettingsCard";
import { Connections, IntegrationId } from "@/components/settings/Connections";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

type ChannelDraft = ApiNotificationChannel & {
  webhookUrl?: string;
  tempId?: string;
};
type WebhookDraft = ApiWebhook & { url?: string; tempId?: string };

export function IntegrationsSection({
  projectId,
  project,
  patchProject,
  replaceProject,
}: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const repository = useDraft({ repositoryUrl: project.repositoryUrl || "" });
  const github = useDraft({ githubToken: "" });
  const gitlab = useDraft({
    gitlabHost: project.gitlabHost || "https://gitlab.com",
    gitlabToken: "",
  });

  const coda = useDraft({
    codaDocId: project.codaDocId || "",
    codaTableId: project.codaTableId || "",
    codaHost: project.codaHost || "https://coda.io",
    codaToken: "",
  });

  // A new row carries a real URL; an existing one only ever has the mask
  const channels = useDraft<{ channels: ChannelDraft[] }>({
    channels: project.notificationChannels || [],
  });
  const webhooks = useDraft<{ webhooks: WebhookDraft[] }>({
    webhooks: project.webhooks || [],
  });

  // Rows have no _id until they are saved, and undefined === undefined, so without this
  // removing one unsaved row removed every unsaved row
  const nextTempId = useRef(0);
  const makeTempId = () => `new-${(nextTempId.current += 1)}`;
  const rowKey = (r: { _id?: string; tempId?: string }) =>
    r._id || r.tempId || "";

  const [githubSyncing, setGithubSyncing] = useState(false);
  const [codaSyncing, setCodaSyncing] = useState(false);
  const [gitlabSyncing, setGitlabSyncing] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newChannelType, setNewChannelType] =
    useState<NotificationChannelType>("slack");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");

  function fail(err: unknown, fallback: string) {
    toast(err instanceof Error ? err.message : fallback, "error");
  }

  useDirtyGroup(
    {
      id: "integrations-repository",
      section: "integrations",
      label: "Integrations · Repository",
      count: repository.count,
    },
    {
      save: async () => {
        try {
          const updated = await replaceAndReturn({
            repositoryUrl: repository.value.repositoryUrl.trim(),
          });
          repository.commit({ repositoryUrl: updated.repositoryUrl || "" });
          toast("Repository saved", "success");
        } catch (err) {
          fail(err, "Failed to save the repository");
        }
      },
      discard: repository.discard,
    },
  );

  useDirtyGroup(
    {
      id: "integrations-github",
      section: "integrations",
      label: "Integrations · GitHub",
      count: github.count,
    },
    {
      save: async () => {
        try {
          const payload: Record<string, string> = {};
          if (github.value.githubToken.trim())
            payload.githubToken = github.value.githubToken.trim();
          await replaceAndReturn(payload);
          github.commit({ githubToken: "" });
          toast("GitHub settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save GitHub settings");
        }
      },
      discard: github.discard,
    },
  );

  useDirtyGroup(
    {
      id: "integrations-gitlab",
      section: "integrations",
      label: "Integrations · GitLab",
      count: gitlab.count,
    },
    {
      save: async () => {
        try {
          const payload: Record<string, string> = {
            gitlabHost: gitlab.value.gitlabHost.trim(),
          };
          if (gitlab.value.gitlabToken.trim())
            payload.gitlabToken = gitlab.value.gitlabToken.trim();
          const updated = await replaceAndReturn(payload);
          gitlab.commit({
            gitlabHost: updated.gitlabHost || "https://gitlab.com",
            gitlabToken: "",
          });
          toast("GitLab settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save GitLab settings");
        }
      },
      discard: gitlab.discard,
    },
  );

  useDirtyGroup(
    {
      id: "integrations-coda",
      section: "integrations",
      label: "Integrations · Coda",
      count: coda.count,
    },
    {
      save: async () => {
        try {
          const payload: Record<string, string> = {
            codaDocId: coda.value.codaDocId.trim(),
            codaTableId: coda.value.codaTableId.trim(),
            codaHost: coda.value.codaHost.trim(),
          };
          if (coda.value.codaToken.trim())
            payload.codaToken = coda.value.codaToken.trim();
          const updated = await replaceAndReturn(payload);
          coda.commit({
            codaDocId: updated.codaDocId || "",
            codaTableId: updated.codaTableId || "",
            codaHost: updated.codaHost || "https://coda.io",
            codaToken: "",
          });
          toast("Coda settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save Coda settings");
        }
      },
      discard: coda.discard,
    },
  );

  useDirtyGroup(
    {
      id: "integrations-channels",
      section: "integrations",
      label: "Integrations · Team channels",
      count: channels.count,
    },
    {
      save: async () => {
        const diff = diffById<ChannelDraft>(
          channels.baseline.channels,
          channels.value.channels,
        );
        let saved = project.notificationChannels || [];
        try {
          for (const row of diff.added) {
            saved = await api.post(`/api/projects/${projectId}/notifications`, {
              type: row.type,
              name: row.name,
              webhookUrl: row.webhookUrl,
              events: row.events,
            });
          }
          for (const row of diff.changed) {
            saved = await api.put(`/api/projects/${projectId}/notifications`, {
              channelId: row._id,
              name: row.name,
              events: row.events,
              enabled: row.enabled,
            });
          }
          for (const channelId of diff.removed) {
            saved = await api.del(`/api/projects/${projectId}/notifications`, {
              channelId,
            });
          }
          patchProject({ notificationChannels: saved });
          channels.commit({ channels: saved });
          toast("Channels saved", "success");
        } catch (err) {
          fail(err, "Failed to save channels");
          patchProject({ notificationChannels: saved });
          channels.rebase({ channels: saved });
        }
      },
      discard: channels.discard,
    },
  );

  useDirtyGroup(
    {
      id: "integrations-webhooks",
      section: "integrations",
      label: "Integrations · Webhooks",
      count: webhooks.count,
    },
    {
      save: async () => {
        const diff = diffById<WebhookDraft>(
          webhooks.baseline.webhooks,
          webhooks.value.webhooks,
        );
        let saved = project.webhooks || [];
        try {
          for (const row of diff.added) {
            saved = await api.post(`/api/projects/${projectId}/webhooks`, {
              url: row.url,
              events: row.events,
            });
          }
          for (const row of diff.changed) {
            saved = await api.put(`/api/projects/${projectId}/webhooks`, {
              webhookId: row._id,
              events: row.events,
              enabled: row.enabled,
            });
          }
          for (const webhookId of diff.removed) {
            saved = await api.del(`/api/projects/${projectId}/webhooks`, {
              webhookId,
            });
          }
          // commit, not rebase: on success the server's answer is the whole truth, and the rows
          // it just created carry ids the draft has never seen. Moving the baseline alone would
          // leave those as a difference, so the counter would stay dirty and the next Save would
          // re-issue a diff that had already been applied.
          patchProject({ webhooks: saved });
          webhooks.commit({ webhooks: saved });
          toast("Webhooks saved", "success");
        } catch (err) {
          fail(err, "Failed to save webhooks");
          patchProject({ webhooks: saved });
          webhooks.rebase({ webhooks: saved });
        }
      },
      discard: webhooks.discard,
    },
  );

  async function replaceAndReturn(payload: Record<string, string>) {
    const updated = await api.put(`/api/projects/${projectId}`, payload);
    replaceProject(updated);
    return updated;
  }

  function addWebhook() {
    if (!newWebhookUrl.trim()) return;
    webhooks.set("webhooks", [
      ...webhooks.value.webhooks,
      {
        tempId: makeTempId(),
        urlMasked: newWebhookUrl.trim(),
        url: newWebhookUrl.trim(),
        events: [...WEBHOOK_EVENTS],
        enabled: true,
      } as WebhookDraft,
    ]);
    setNewWebhookUrl("");
  }

  function updateWebhook(webhookId: string, patch: Record<string, unknown>) {
    webhooks.set(
      "webhooks",
      webhooks.value.webhooks.map((w) =>
        rowKey(w) === webhookId ? { ...w, ...patch } : w,
      ),
    );
  }

  function removeWebhook(webhookId: string) {
    webhooks.set(
      "webhooks",
      webhooks.value.webhooks.filter((w) => rowKey(w) !== webhookId),
    );
  }

  /** Rotating a credential is an action with a verb, so it happens now, not on save. */
  async function replaceWebhookUrl(webhookId: string, url: string) {
    if (webhooks.count > 0) {
      toast("Save or discard your webhook changes before replacing a URL", "error");
      return false;
    }
    try {
      const saved: ApiWebhook[] = await api.put(
        `/api/projects/${projectId}/webhooks`,
        {
          webhookId,
          url,
        },
      );
      patchProject({ webhooks: saved });
      webhooks.commit({ webhooks: saved });
      toast("Webhook URL replaced", "success");
    } catch (err) {
      fail(err, "Failed to replace the URL");
      return false;
    }
  }

  function addChannel() {
    if (!newChannelName.trim() || !newChannelUrl.trim()) return;
    channels.set("channels", [
      ...channels.value.channels,
      {
        type: newChannelType,
        name: newChannelName.trim(),
        tempId: makeTempId(),
        webhookUrlMasked: newChannelUrl.trim(),
        webhookUrl: newChannelUrl.trim(),
        events: [...WEBHOOK_EVENTS],
        enabled: true,
      } as ChannelDraft,
    ]);
    setNewChannelName("");
    setNewChannelUrl("");
  }

  function updateChannel(channelId: string, patch: Record<string, unknown>) {
    channels.set(
      "channels",
      channels.value.channels.map((c) =>
        rowKey(c) === channelId ? { ...c, ...patch } : c,
      ),
    );
  }

  function removeChannel(channelId: string) {
    channels.set(
      "channels",
      channels.value.channels.filter((c) => rowKey(c) !== channelId),
    );
  }

  async function replaceChannelUrl(channelId: string, webhookUrl: string) {
    // Rotating commits the server's answer over the whole draft, which would swallow any
    // row staged but not saved. Ask for that to be settled rather than losing it silently.
    if (channels.count > 0) {
      toast("Save or discard your channel changes before replacing a URL", "error");
      return false;
    }
    try {
      const saved: ApiNotificationChannel[] = await api.put(
        `/api/projects/${projectId}/notifications`,
        { channelId, webhookUrl },
      );
      patchProject({ notificationChannels: saved });
      channels.commit({ channels: saved });
      toast("Webhook URL replaced", "success");
    } catch (err) {
      fail(err, "Failed to replace the URL");
      return false;
    }
  }

  function toggleEvent(current: WebhookEvent[], event: WebhookEvent) {
    return current.includes(event)
      ? current.filter((e) => e !== event)
      : [...current, event];
  }

  // A vendor's form appears once it is configured, or once it is picked from the
  // catalogue — not merely because the vendor exists
  const [opened, setOpened] = useState<IntegrationId[]>([]);
  const [expanded, setExpanded] = useState<IntegrationId | null>(null);

  const providerLabel =
    project.repositoryProvider === "github"
      ? "GitHub"
      : project.repositoryProvider === "gitlab"
        ? "GitLab"
        : "";

  return (
    <>
      <SettingsCard
        title="Where the code lives"
        // Only once something is typed: an empty field is not a failure to recognise
        status={
          repository.value.repositoryUrl.trim()
            ? {
                label: providerLabel || "Host not recognised",
                on: !!providerLabel,
              }
            : undefined
        }
        description="One URL, whoever hosts it. Pull-request linking parses it, a worker is told to fetch it — and pasting a GitHub or GitLab address is what adds that connection below."
      >
        <SettingRow
          label="Repository URL"
          hint="Paste the address you would clone from"
        >
          <Input
            value={repository.value.repositoryUrl}
            aria-label="Repository URL"
            dirty={repository.isDirty("repositoryUrl")}
            onChange={(e) => repository.set("repositoryUrl", e.target.value)}
            placeholder="https://github.com/owner/repo"
          />
          {repository.value.repositoryUrl.trim() && (
            <p className="mt-1.5 text-xs text-text-muted">
              {providerLabel
                ? `Recognised as ${providerLabel}, so its connection is listed below.`
                : "Not github.com or gitlab.com. A self-hosted GitLab is recognised once its host matches; anything else links no pull requests."}
            </p>
          )}
        </SettingRow>
      </SettingsCard>

      <Connections
        project={project}
        opened={opened}
        expanded={expanded}
        onExpand={setExpanded}
        onOpen={(id) => setOpened((o) => (o.includes(id) ? o : [...o, id]))}
        onRemove={(id) => {
          setOpened((o) => o.filter((x) => x !== id));
          setExpanded((e) => (e === id ? null : e));
        }}
        renderBody={(id) => {
          switch (id) {
            case "github":
              return (
                <>
                  <p className="text-sm text-text-muted">
                    Links pull requests to tasks by task key in the branch name
                    or PR title. Uses the repository URL above.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Input
                        label="Access token"
                        type="password"
                        value={github.value.githubToken}
                        dirty={github.isDirty("githubToken")}
                        onChange={(e) =>
                          github.set("githubToken", e.target.value)
                        }
                        placeholder={
                          project.githubTokenSet
                            ? "Set — enter a new token to replace"
                            : "ghp_... (fine-grained or classic)"
                        }
                      />
                      <p className="mt-1 text-xs text-text-muted">
                        Needs <code>repo</code> scope (read access to pull
                        requests).
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
                            const result = await api.post(
                              `/api/projects/${projectId}/github/sync`,
                              {},
                            );
                            toast(
                              `Synced: ${result.prsLinked} PRs linked to ${result.tasksLinked} tasks${
                                result.autoTransitioned > 0
                                  ? `, ${result.autoTransitioned} auto-transitioned`
                                  : ""
                              }`,
                              "success",
                            );
                          } catch (err) {
                            fail(err, "Sync failed");
                          } finally {
                            setGithubSyncing(false);
                          }
                        }}
                      >
                        {githubSyncing
                          ? "Syncing..."
                          : "Sync pull requests now"}
                      </Button>
                    </div>
                  )}
                </>
              );
            case "gitlab":
              return (
                <>
                  <p className="text-sm text-text-muted">
                    Same matching as GitHub, for merge requests. Uses the
                    repository URL above; a self-hosted instance is recognised
                    by the host below.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label="Host"
                      value={gitlab.value.gitlabHost}
                      dirty={gitlab.isDirty("gitlabHost")}
                      onChange={(e) => gitlab.set("gitlabHost", e.target.value)}
                      placeholder="https://gitlab.com (or your self-hosted instance)"
                    />
                  </div>
                  {project.gitlabTokenSet &&
                    clearsStoredToken(
                      gitlab.value.gitlabHost,
                      gitlab.baseline.gitlabHost,
                      gitlab.value.gitlabToken,
                      "https://gitlab.com"
                    ) && (
                      <p className="text-sm text-warning">
                        The stored token was issued for the old host. Saving a new host clears it —
                        enter the token for the new host below, or it will have to be re-entered
                        before the next sync.
                      </p>
                    )}
                  <Input
                    label="Access token"
                    type="password"
                    value={gitlab.value.gitlabToken}
                    dirty={gitlab.isDirty("gitlabToken")}
                    onChange={(e) => gitlab.set("gitlabToken", e.target.value)}
                    placeholder={
                      project.gitlabTokenSet
                        ? "Set — enter a new token to replace"
                        : "glpat-... (needs read_api scope)"
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    {project.gitlabTokenSet &&
                      project.repositoryProvider === "gitlab" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={gitlabSyncing}
                          onClick={async () => {
                            setGitlabSyncing(true);
                            try {
                              const result = await api.post(
                                `/api/projects/${projectId}/gitlab/sync`,
                                {},
                              );
                              toast(
                                `Synced: ${result.prsLinked} MRs linked to ${result.tasksLinked} tasks${
                                  result.autoTransitioned > 0
                                    ? `, ${result.autoTransitioned} auto-transitioned`
                                    : ""
                                }`,
                                "success",
                              );
                            } catch (err) {
                              fail(err, "Sync failed");
                            } finally {
                              setGitlabSyncing(false);
                            }
                          }}
                        >
                          {gitlabSyncing
                            ? "Syncing..."
                            : "Sync merge requests now"}
                        </Button>
                      )}
                    {project.gitlabTokenSet && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          try {
                            replaceProject(
                              await api.put(`/api/projects/${projectId}`, {
                                gitlabHost: "https://gitlab.com",
                                gitlabToken: "",
                              }),
                            );
                            gitlab.commit({
                              gitlabHost: "https://gitlab.com",
                              gitlabToken: "",
                            });
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
                </>
              );
            case "coda":
              return (
                <>
                  <p className="text-sm text-text-muted">
                    Mirrors this board into a Coda table. One-way: Coda never
                    writes back.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label="Doc ID"
                      value={coda.value.codaDocId}
                      dirty={coda.isDirty("codaDocId")}
                      onChange={(e) => coda.set("codaDocId", e.target.value)}
                      placeholder="from the doc URL, e.g. dNc_5Xy0abc"
                    />
                    <Input
                      label="Table ID or name"
                      value={coda.value.codaTableId}
                      dirty={coda.isDirty("codaTableId")}
                      onChange={(e) => coda.set("codaTableId", e.target.value)}
                      placeholder="grid-abc123 or Tasks"
                    />
                  </div>
                  <Input
                    label="Host"
                    value={coda.value.codaHost}
                    dirty={coda.isDirty("codaHost")}
                    onChange={(e) => coda.set("codaHost", e.target.value)}
                    placeholder="https://coda.io"
                  />
                  {project.codaTokenSet &&
                    clearsStoredToken(
                      coda.value.codaHost,
                      coda.baseline.codaHost,
                      coda.value.codaToken,
                      "https://coda.io"
                    ) && (
                      <p className="text-sm text-warning">
                        The stored token was issued for the old host. Saving a new host clears it —
                        enter the token for the new host below, or it will have to be re-entered
                        before the next sync.
                      </p>
                    )}
                  <Input
                    label="API token"
                    type="password"
                    value={coda.value.codaToken}
                    dirty={coda.isDirty("codaToken")}
                    onChange={(e) => coda.set("codaToken", e.target.value)}
                    placeholder={
                      project.codaTokenSet
                        ? "Set — enter a new token to replace"
                        : "Coda API token"
                    }
                  />
                  <p className="text-xs text-text-muted">
                    The table must already have these columns:{" "}
                    {CODA_COLUMNS.join(", ")}. Rows are matched on{" "}
                    {CODA_KEY_COLUMN}, so syncing twice updates instead of
                    duplicating.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {project.codaTokenSet &&
                      project.codaDocId &&
                      project.codaTableId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={codaSyncing}
                          onClick={async () => {
                            setCodaSyncing(true);
                            try {
                              const result = await api.post(
                                `/api/projects/${projectId}/coda/sync`,
                                {},
                              );
                              toast(
                                result.allApplied
                                  ? `Synced ${result.tasksPushed} tasks to Coda`
                                  : `Sent ${result.tasksPushed} tasks — Coda is still applying them`,
                                result.allApplied ? "success" : "info",
                              );
                            } catch (err) {
                              fail(err, "Coda sync failed");
                            } finally {
                              setCodaSyncing(false);
                            }
                          }}
                        >
                          {codaSyncing ? "Syncing..." : "Sync tasks now"}
                        </Button>
                      )}
                    {(project.codaTokenSet || project.codaDocId) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          try {
                            replaceProject(
                              await api.put(`/api/projects/${projectId}`, {
                                codaDocId: "",
                                codaTableId: "",
                                codaHost: "https://coda.io",
                                codaToken: "",
                              }),
                            );
                            coda.commit({
                              codaDocId: "",
                              codaTableId: "",
                              codaHost: "https://coda.io",
                              codaToken: "",
                            });
                            toast("Coda disconnected", "success");
                          } catch (err) {
                            fail(err, "Failed to disconnect Coda");
                          }
                        }}
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                </>
              );
            case "channels":
              return (
                <>
                  <p className="text-sm text-text-muted">
                    Posts a formatted message to a shared channel when something happens on the
                    board — the same message for everyone, regardless of who watches what. For the
                    notifications addressed to you, see My notifications.
                  </p>
                  <div className="space-y-3">
                    {channels.value.channels.map((ch) => (
                      <div
                        key={rowKey(ch)}
                        className="rounded-lg border border-border p-3"
                      >
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
                            <span className="text-sm font-medium">
                              {ch.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() =>
                                updateChannel(rowKey(ch), {
                                  enabled: !ch.enabled,
                                })
                              }
                              className={`rounded px-2 py-0.5 text-xs ${
                                ch.enabled
                                  ? "bg-green-500/10 text-green-500"
                                  : "bg-bg-input text-text-muted"
                              }`}
                            >
                              {ch.enabled ? "Active" : "Disabled"}
                            </button>
                            <button
                              onClick={() => removeChannel(rowKey(ch))}
                              className="text-xs text-text-muted hover:text-danger"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className="mb-2">
                          <SecretField
                            disabled={!ch._id}
                            label={`Webhook URL for ${ch.name}`}
                            masked={ch.webhookUrlMasked}
                            placeholder={
                              ch.type === "slack"
                                ? "https://hooks.slack.com/services/..."
                                : "https://discord.com/api/webhooks/..."
                            }
                            onReplace={(webhookUrl) =>
                              replaceChannelUrl(ch._id, webhookUrl)
                            }
                          />
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {WEBHOOK_EVENTS.map((evt) => (
                            <button
                              key={evt}
                              onClick={() =>
                                updateChannel(rowKey(ch), {
                                  events: toggleEvent(ch.events, evt),
                                })
                              }
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
                    {channels.value.channels.length === 0 && (
                      <EmptyState>
                        No channels yet. Add one to get board updates in Slack
                        or Discord.
                      </EmptyState>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={newChannelType}
                        onChange={(e) =>
                          setNewChannelType(
                            e.target.value as NotificationChannelType,
                          )
                        }
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
                </>
              );
            case "webhooks":
              return (
                <>
                  <p className="text-sm text-text-muted">
                    Raw HTTP POST to your own endpoint when an event fires.
                  </p>
                  <div className="space-y-3">
                    {webhooks.value.webhooks.map((wh) => (
                      <div
                        key={rowKey(wh)}
                        className="rounded-lg border border-border p-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="min-w-0 max-w-[380px] flex-1">
                            <SecretField
                              disabled={!wh._id}
                              label="Webhook URL"
                              masked={wh.urlMasked}
                              placeholder="https://example.com/hooks/board"
                              onReplace={(url) =>
                                replaceWebhookUrl(wh._id, url)
                              }
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() =>
                                updateWebhook(rowKey(wh), {
                                  enabled: !wh.enabled,
                                })
                              }
                              className={`rounded px-2 py-0.5 text-xs ${
                                wh.enabled
                                  ? "bg-green-500/10 text-green-500"
                                  : "bg-bg-input text-text-muted"
                              }`}
                            >
                              {wh.enabled ? "Active" : "Disabled"}
                            </button>
                            <button
                              onClick={() => removeWebhook(rowKey(wh))}
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
                              onClick={() =>
                                updateWebhook(rowKey(wh), {
                                  events: toggleEvent(wh.events, evt),
                                })
                              }
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
                        {wh._id && (
                          <p className="mt-2 text-xs text-text-muted">
                            {wh.lastAttemptAt ? (
                              wh.lastStatus === "failed" ? (
                                <span className="text-danger">
                                  Last delivery failed {timeAgo(wh.lastAttemptAt)}
                                  {wh.lastError ? ` — ${wh.lastError}` : ""}
                                </span>
                              ) : (
                                <>Last delivered {timeAgo(wh.lastAttemptAt)}</>
                              )
                            ) : (
                              "Not delivered yet"
                            )}
                          </p>
                        )}
                      </div>
                    ))}
                    {webhooks.value.webhooks.length === 0 && (
                      <EmptyState>
                        No webhooks yet. Add a URL to receive board events as
                        JSON.
                      </EmptyState>
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
                </>
              );
            default:
              return null;
          }
        }}
      />
    </>
  );
}
