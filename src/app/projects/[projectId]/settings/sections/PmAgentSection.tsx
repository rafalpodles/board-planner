"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { ApiProject } from "@/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { firstReviewHour, reviewHoursOfDay } from "@/lib/pm/autonomy";
import { SettingsCard, EmptyState, ListRow } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

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
}

interface McpTransient {
  testing?: boolean;
  testResult?: string;
  connecting?: boolean;
}

const REVIEW_INTERVALS = [
  { value: "24", label: "Once a day" },
  { value: "12", label: "Every 12 hours" },
  { value: "8", label: "Every 8 hours" },
  { value: "6", label: "Every 6 hours" },
  { value: "4", label: "Every 4 hours" },
  { value: "3", label: "Every 3 hours" },
  { value: "2", label: "Every 2 hours" },
];

function pmDraftFrom(p: ApiProject) {
  return {
    enabled: p.pm?.enabled || false,
    model: p.pm?.model || "",
    dailyCap: p.pm?.dailyTurnCap ? String(p.pm.dailyTurnCap) : "",
    contextNotes: p.pm?.contextNotes || "",
    links: (p.pm?.links || []).map((l) => ({ label: l.label, url: l.url })),
    dailyReview: p.pm?.autonomy?.dailyReview ?? false,
    reviewHour: String(p.pm?.autonomy?.reviewHour ?? 9),
    reviewInterval: String(p.pm?.autonomy?.reviewIntervalHours ?? 24),
    timezone: p.pm?.autonomy?.timezone || "Europe/Warsaw",
    handleNhr: p.pm?.autonomy?.handleNeedsHumanReview ?? false,
    mcpServers: (p.pm?.mcpServers || []).map(
      (s): McpServerDraft => ({
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
      })
    ),
  };
}

export function PmAgentSection({ projectId, project, replaceProject, isAdmin }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const draft = useDraft(pmDraftFrom(project));
  const [transient, setTransient] = useState<Record<number, McpTransient>>({});
  const [newLinkLabel, setNewLinkLabel] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");

  const servers = draft.value.mcpServers;
  const reviewTimes = reviewHoursOfDay(
    firstReviewHour({ reviewHour: Number(draft.value.reviewHour) }),
    Number(draft.value.reviewInterval)
  );

  function setTransientAt(index: number, patch: McpTransient) {
    setTransient((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));
  }

  function updateServer(index: number, patch: Partial<McpServerDraft>) {
    draft.set(
      "mcpServers",
      servers.map((s, i) => (i === index ? { ...s, ...patch } : s))
    );
  }

  async function savePm(options?: { silent?: boolean }): Promise<boolean> {
    const v = draft.value;
    const pm: Record<string, unknown> = {
      contextNotes: v.contextNotes,
      links: v.links,
      autonomy: {
        dailyReview: v.dailyReview,
        reviewHour: firstReviewHour({ reviewHour: Number(v.reviewHour) }),
        reviewIntervalHours: Number(v.reviewInterval) || 24,
        timezone: v.timezone.trim(),
        handleNeedsHumanReview: v.handleNhr,
      },
    };
    if (isAdmin) {
      pm.enabled = v.enabled;
      pm.model = v.model.trim();
      pm.dailyTurnCap = v.dailyCap.trim() ? Number(v.dailyCap) : 0;
      pm.mcpServers = v.mcpServers
        .filter((s) => s.name.trim() || s.url.trim())
        .map((s) => ({
          name: s.name.trim(),
          url: s.url.trim(),
          authType: s.authType,
          authToken: s.authToken,
          oauthClientId: s.oauthClientId.trim(),
          oauthClientSecret: s.oauthClientSecret,
          allowWrites: s.allowWrites,
          toolAllowlist: s.toolAllowlist.split(",").map((t) => t.trim()).filter(Boolean),
          enabled: s.enabled,
        }));
    }
    try {
      const updated = await api.put(`/api/projects/${projectId}`, { pm });
      replaceProject(updated);
      draft.commit(pmDraftFrom(updated));
      if (!options?.silent) toast("PM settings saved", "success");
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save PM settings", "error");
      return false;
    }
  }

  useDirtyGroup(
    { id: "pm-agent", section: "pm", label: "PM agent", count: draft.count },
    { save: async () => void (await savePm()), discard: draft.discard }
  );

  async function testServer(index: number) {
    const server = servers[index];
    setTransientAt(index, { testing: true, testResult: "" });
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
      setTransientAt(index, {
        testing: false,
        testResult: `✓ Connected — ${res.count} tools: ${names || "(none)"}`,
      });
    } catch (err) {
      setTransientAt(index, {
        testing: false,
        testResult: `✗ ${err instanceof Error ? err.message : "Connection failed"}`,
      });
    }
  }

  async function connectOauth(index: number) {
    const serverName = servers[index].name.trim();
    setTransientAt(index, { connecting: true, testResult: "" });
    // Persist the draft first so Connect works without a manual save
    if (!(await savePm({ silent: true }))) {
      setTransientAt(index, { connecting: false });
      return;
    }
    try {
      const res = await api.post(`/api/projects/${projectId}/pm/mcp-oauth/start`, { name: serverName });
      window.location.href = res.authorizationUrl;
    } catch (err) {
      setTransientAt(index, {
        connecting: false,
        testResult: `✗ ${err instanceof Error ? err.message : "OAuth start failed"}`,
      });
    }
  }

  async function disconnectOauth(index: number) {
    try {
      await api.post(`/api/projects/${projectId}/pm/mcp-oauth/disconnect`, {
        name: servers[index].name.trim(),
      });
      updateServer(index, { oauthStatus: "unconfigured" });
      toast("OAuth connection removed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Disconnect failed", "error");
    }
  }

  if (!project.pmAvailable) {
    return (
      <SettingsCard title="PM agent" contract="readonly">
        <p className="text-sm text-text-muted">
          Set the <code>OPENROUTER_API_KEY</code> environment variable on the server to enable the PM
          agent (optionally <code>PM_MODEL</code> for the default model).
        </p>
      </SettingsCard>
    );
  }

  const lockedByInstance = !!project.pm?.lockedByInstance;

  return (
    <>
      {lockedByInstance && (
        <div className="mb-4 flex gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          <span aria-hidden="true">⛔</span>
          <p>
            <strong className="font-semibold">An instance admin has locked this agent off.</strong> It
            will not run for this project, and the switch below cannot override it.
          </p>
        </div>
      )}
      {isAdmin ? (
        <SettingsCard title="Availability & cost" contract="draft" instanceScoped>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={draft.value.enabled}
              onChange={(e) => draft.set("enabled", e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="text-sm">Run the PM agent on this project</span>
              <span className="mt-0.5 block text-xs text-text-muted">
                Turns on chat and, if you allow it below, autonomous turns.
              </span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Input
                label="Turns per day"
                type="number"
                min={0}
                max={1000}
                value={draft.value.dailyCap}
                dirty={draft.isDirty("dailyCap")}
                onChange={(e) => draft.set("dailyCap", e.target.value)}
                placeholder="Leave empty for the server default"
              />
              <p className="mt-1 text-xs text-text-muted">Autonomous turns count against this too.</p>
            </div>
          </div>
        </SettingsCard>
      ) : (
        <div className="mb-4 flex gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
          <span aria-hidden="true">ℹ</span>
          <p>
            <strong className="font-semibold">
              Model, turn budget and MCP connections are set by the instance admin.
            </strong>{" "}
            You can still change what the agent knows and when it acts.
          </p>
        </div>
      )}

      <SettingsCard title="What the agent knows" contract="draft">
        <div>
          <Textarea
            label="Project context"
            value={draft.value.contextNotes}
            dirty={draft.isDirty("contextNotes")}
            onChange={(e) => draft.set("contextNotes", e.target.value)}
            rows={5}
            maxLength={5000}
            placeholder="What this project is, conventions, priorities."
          />
          <p className="mt-1 text-xs text-text-muted">
            Added to the agent&apos;s system prompt on every turn. Up to 5000 characters.
          </p>
        </div>
        <div>
          <label className="mb-1 flex items-center gap-2 text-sm font-medium text-text-muted">
            Documentation links
            {draft.isDirty("links") && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
          </label>
          <div className="space-y-2">
            {draft.value.links.map((link, i) => (
              <ListRow key={i}>
                <span className="text-sm font-medium">{link.label}</span>
                <span className="flex-1 truncate text-xs text-text-muted">{link.url}</span>
                <button
                  type="button"
                  onClick={() =>
                    draft.set("links", draft.value.links.filter((_, idx) => idx !== i))
                  }
                  className="text-danger hover:opacity-80"
                  aria-label={`Remove ${link.label}`}
                >
                  ✕
                </button>
              </ListRow>
            ))}
            {draft.value.links.length === 0 && (
              <EmptyState>No links yet. Point the agent at docs it should read.</EmptyState>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <div className="w-[160px] shrink-0">
              <Input
                value={newLinkLabel}
                onChange={(e) => setNewLinkLabel(e.target.value)}
                placeholder="Label"
              />
            </div>
            <Input
              value={newLinkUrl}
              onChange={(e) => setNewLinkUrl(e.target.value)}
              placeholder="https://..."
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!newLinkLabel.trim() || !newLinkUrl.trim()}
              onClick={() => {
                draft.set("links", [
                  ...draft.value.links,
                  { label: newLinkLabel.trim(), url: newLinkUrl.trim() },
                ]);
                setNewLinkLabel("");
                setNewLinkUrl("");
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="When it acts on its own"
        contract="draft"
        description="Autonomous turns count against the daily turn cap and post into the PM chat thread."
      >
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={draft.value.dailyReview}
            onChange={(e) => draft.set("dailyReview", e.target.checked)}
            className="mt-1 rounded border-border"
          />
          <span>
            <span className="text-sm">Review the board on a schedule</span>
            <span className="mt-0.5 block text-xs text-text-muted">
              Flags tasks with no acceptance criteria, tasks stuck in one column and likely
              duplicates, then posts a report into the PM chat thread. It refines task text but
              never moves or creates tasks.
            </span>
          </span>
        </label>
        {draft.value.dailyReview && (
          <div className="ml-6 space-y-2 border-l-2 border-border pl-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="First review at"
                type="number"
                min={0}
                max={23}
                value={draft.value.reviewHour}
                dirty={draft.isDirty("reviewHour")}
                onChange={(e) => draft.set("reviewHour", e.target.value)}
              />
              <Select
                label="How often"
                options={REVIEW_INTERVALS}
                value={draft.value.reviewInterval}
                dirty={draft.isDirty("reviewInterval")}
                onChange={(e) => draft.set("reviewInterval", e.target.value)}
              />
              <Input
                label="Timezone"
                value={draft.value.timezone}
                dirty={draft.isDirty("timezone")}
                onChange={(e) => draft.set("timezone", e.target.value)}
                placeholder="Europe/Warsaw"
              />
            </div>
            <p className="text-xs text-text-muted">
              {reviewTimes.length === 1 ? "One review a day" : `${reviewTimes.length} reviews a day`}
              , at {reviewTimes.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} in{" "}
              {draft.value.timezone.trim() || "the project timezone"}. Each one uses a turn from the
              daily cap.
            </p>
          </div>
        )}
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={draft.value.handleNhr}
            onChange={(e) => draft.set("handleNhr", e.target.checked)}
            className="mt-1 rounded border-border"
          />
          <span>
            <span className="text-sm">Review tasks that land in &quot;Needs human review&quot;</span>
            <span className="mt-0.5 block text-xs text-text-muted">
              Queued as they arrive, one turn each.
            </span>
          </span>
        </label>
      </SettingsCard>

      {isAdmin && (
        <SettingsCard
          title="MCP connections"
          contract="draft"
          instanceScoped
          description="External MCP servers the agent may read at the start of a turn. Writing is off unless you allow it per server."
        >
          <div className="space-y-3">
            {servers.map((server, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className="w-[180px] shrink-0">
                    <Input
                      value={server.name}
                      onChange={(e) => updateServer(i, { name: e.target.value })}
                      placeholder="name (slug, e.g. notion)"
                    />
                  </div>
                  <Input
                    value={server.url}
                    onChange={(e) => updateServer(i, { url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      draft.set("mcpServers", servers.filter((_, idx) => idx !== i))
                    }
                    className="text-danger hover:opacity-80"
                    aria-label="Remove MCP server"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={server.authType}
                    onChange={(e) =>
                      updateServer(i, { authType: e.target.value as "none" | "bearer" | "oauth" })
                    }
                    className="rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm"
                  >
                    <option value="none">No auth</option>
                    <option value="bearer">Bearer token</option>
                    <option value="oauth">OAuth</option>
                  </select>
                  {server.authType === "bearer" && (
                    <Input
                      type="password"
                      value={server.authToken}
                      onChange={(e) => updateServer(i, { authToken: e.target.value })}
                      placeholder={server.hasAuthToken ? "Token set — leave empty to keep" : "Token"}
                    />
                  )}
                  {server.authType === "oauth" && (
                    <>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
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
                        variant="secondary"
                        size="sm"
                        disabled={transient[i]?.connecting || !server.name.trim()}
                        onClick={() => connectOauth(i)}
                      >
                        {transient[i]?.connecting
                          ? "Redirecting..."
                          : server.oauthStatus === "connected"
                            ? "Reconnect"
                            : "Connect"}
                      </Button>
                      {server.oauthStatus === "connected" && (
                        <Button variant="secondary" size="sm" onClick={() => disconnectOauth(i)}>
                          Disconnect
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {server.authType === "oauth" && (
                  <div className="flex gap-2">
                    <Input
                      value={server.oauthClientId}
                      onChange={(e) => updateServer(i, { oauthClientId: e.target.value })}
                      placeholder="Client ID (optional — auto-registered when supported)"
                    />
                    <Input
                      type="password"
                      value={server.oauthClientSecret}
                      onChange={(e) => updateServer(i, { oauthClientSecret: e.target.value })}
                      placeholder="Client secret (optional)"
                    />
                  </div>
                )}
                <Input
                  value={server.toolAllowlist}
                  onChange={(e) => updateServer(i, { toolAllowlist: e.target.value })}
                  placeholder="Tool allowlist, comma-separated (empty = all)"
                />
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(e) => updateServer(i, { enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={server.allowWrites}
                      onChange={(e) => updateServer(i, { allowWrites: e.target.checked })}
                    />
                    Allow writes
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={transient[i]?.testing || !server.url.trim()}
                    onClick={() => testServer(i)}
                  >
                    {transient[i]?.testing ? "Testing..." : "Test connection"}
                  </Button>
                </div>
                {transient[i]?.testResult && (
                  <p className="whitespace-pre-wrap text-xs text-text-muted">{transient[i].testResult}</p>
                )}
              </div>
            ))}
            {servers.length === 0 && (
              <EmptyState>No MCP servers yet. Add one to give the agent read access to an external tool.</EmptyState>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={servers.length >= 5}
            onClick={() =>
              draft.set("mcpServers", [
                ...servers,
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
        </SettingsCard>
      )}
    </>
  );
}
