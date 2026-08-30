"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { isValidTimezone } from "@/lib/time";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { ApiProject, DEFAULT_PM_AUTONOMY } from "@/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
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
  /**
   * The same two refusals `validatePmConfig` gives, asked here so they reach the field rather
   * than arriving as a toast after the save — with the draft still dirty and nothing saying which
   * field was at fault. `reviewHour` and `reviewInterval` were already safe this way: one is
   * clamped before posting and the other comes from a fixed select.
   */
  const typedTimezone = draft.value.timezone.trim();
  const timezoneReadable = isValidTimezone(typedTimezone);
  /**
   * Only while the schedule is on, which is the only time this field is rendered. Judging it
   * always meant an unreadable value typed and then undone by switching the schedule off went on
   * refusing **every** later save — of context notes, of links, of anything — through a toast
   * about a field no longer on screen. That is the very failure this change exists to remove.
   */
  const timezoneError = !draft.value.dailyReview
    ? ""
    : timezoneReadable
      ? ""
      : typedTimezone
        ? `Not a timezone this server knows: ${typedTimezone}`
        : "A review has to run somewhere — name a timezone, for example Europe/Warsaw.";
  // What the project already has, which is by definition something the server accepted
  const storedTimezone = project.pm?.autonomy?.timezone || DEFAULT_PM_AUTONOMY.timezone;

  const typedCap = draft.value.dailyCap.trim();
  const capNumber = Number(typedCap);
  const capError =
    typedCap &&
    (!Number.isFinite(capNumber) || !Number.isInteger(capNumber) || capNumber < 0 || capNumber > 1000)
      ? "A whole number of turns, 0 to 1000. 0 means the server's own default."
      : "";

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
    // The field already says what is wrong; sending it would answer 400 and say the same thing
    // one round trip later, in a toast that does not name the field.
    if (timezoneError || capError) {
      // Not gated on `silent`: connectOauth saves silently first, and swallowing this made
      // Connect a button that flickered and did nothing with no reason given anywhere.
      toast(timezoneError || capError, "error");
      return false;
    }
    const v = draft.value;
    const pm: Record<string, unknown> = {
      contextNotes: v.contextNotes,
      links: v.links,
      autonomy: {
        dailyReview: v.dailyReview,
        reviewHour: firstReviewHour({ reviewHour: Number(v.reviewHour) }),
        reviewIntervalHours: Number(v.reviewInterval) || 24,
        // The server judges this whether or not the schedule is on, and an empty string is not
        // nullish so its `??` fallback never fires. A hidden, unreadable value must not be what
        // blocks an unrelated save.
        timezone: timezoneReadable ? v.timezone.trim() : storedTimezone,
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
      <SettingsCard title="PM agent">
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
        <SettingsCard title="Availability & cost" instanceScoped>
          <Switch
            checked={draft.value.enabled}
            onChange={(v) => draft.set("enabled", v)}
            label="Run the PM agent on this project"
            hint="Turns on chat and, if you allow it below, autonomous turns."
          />
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
                error={capError}
                placeholder="Leave empty for the server default"
              />
              <p className="mt-1 text-xs text-text-muted">
                Autonomous turns count too, and so does a turn the model failed. Resets at midnight
                in {storedTimezone}.
              </p>
            </div>
          </div>
        </SettingsCard>
      ) : (
        <div className="mb-4 flex gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
          <span aria-hidden="true">ℹ</span>
          <p>
            <strong className="font-semibold">Model and turn budget are set by the instance admin.</strong>{" "}
            You can still change what the agent knows, when it acts, and connect or test the MCP
            servers the instance admin has configured.
          </p>
        </div>
      )}

      <SettingsCard title="What the agent knows">
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
            <div className="min-w-0 flex-1 sm:w-[160px] sm:flex-none sm:shrink-0">
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
        description="Autonomous turns count against the daily turn cap and post into the PM chat thread."
      >
        <Switch
          checked={draft.value.dailyReview}
          onChange={(v) => draft.set("dailyReview", v)}
          label="Review the board on a schedule"
          hint={`Flags tasks with no acceptance criteria, tasks stuck in one column and likely duplicates, then posts a report into the PM chat thread. It refines task text but never moves or creates tasks.`}
        />
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
                error={timezoneError}
                placeholder="Europe/Warsaw"
              />
            </div>
            <p className="text-xs text-text-muted">
              {timezoneError ? (
                <>Name a timezone this server knows and the schedule will appear here.</>
              ) : (
                <>
                  {reviewTimes.length === 1
                    ? "One review a day"
                    : `${reviewTimes.length} reviews a day`}
                  , at {reviewTimes.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} in{" "}
                  {typedTimezone}. Each one uses a turn from the daily cap.
                </>
              )}
            </p>
          </div>
        )}
        <Switch
          checked={draft.value.handleNhr}
          onChange={(v) => draft.set("handleNhr", v)}
          label={'Review tasks that land in "Needs human review"'}
          hint="Queued as they arrive, one turn each. It answers in a comment — it never moves or assigns the task."
        />
      </SettingsCard>

      {project.canAdmin && (
        <SettingsCard
          title="MCP connections"
          description={
            isAdmin
              ? "External MCP servers the agent may read at the start of a turn. Writing is off unless you allow it per server."
              : "External MCP servers the agent may read at the start of a turn. The instance admin manages which servers exist — you can connect, disconnect and test what's already set up."
          }
        >
          <div className="space-y-3">
            {servers.map((server, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                {isAdmin ? (
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 sm:w-[180px] sm:flex-none sm:shrink-0">
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
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-danger hover:opacity-80 sm:h-6 sm:w-auto sm:px-1"
                      aria-label="Remove MCP server"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="text-sm font-medium">{server.name || `Server ${i + 1}`}</div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {isAdmin && (
                    <select
                      value={server.authType}
                      onChange={(e) =>
                        updateServer(i, { authType: e.target.value as "none" | "bearer" | "oauth" })
                      }
                      className="rounded-lg border border-border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0"
                    >
                      <option value="none">No auth</option>
                      <option value="bearer">Bearer token</option>
                      <option value="oauth">OAuth</option>
                    </select>
                  )}
                  {isAdmin && server.authType === "bearer" && (
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
                      {project.canAdmin && (
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
                      )}
                      {project.canAdmin && server.oauthStatus === "connected" && (
                        <Button variant="secondary" size="sm" onClick={() => disconnectOauth(i)}>
                          Disconnect
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {isAdmin && server.authType === "oauth" && (
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
                {isAdmin && (
                  <Input
                    value={server.toolAllowlist}
                    onChange={(e) => updateServer(i, { toolAllowlist: e.target.value })}
                    placeholder="Tool allowlist, comma-separated (empty = all)"
                  />
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  {isAdmin && (
                    <Switch
                      checked={server.enabled}
                      onChange={(v) => updateServer(i, { enabled: v })}
                      label="Enabled"
                    />
                  )}
                  {isAdmin && (
                    <Switch
                      checked={server.allowWrites}
                      onChange={(v) => updateServer(i, { allowWrites: v })}
                      label="Allow writes"
                    />
                  )}
                  {project.canAdmin && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={transient[i]?.testing || !server.url.trim()}
                      onClick={() => testServer(i)}
                    >
                      {transient[i]?.testing ? "Testing..." : "Test connection"}
                    </Button>
                  )}
                </div>
                {transient[i]?.testResult && (
                  <p className="whitespace-pre-wrap text-xs text-text-muted">{transient[i].testResult}</p>
                )}
              </div>
            ))}
            {servers.length === 0 && (
              <EmptyState>
                {isAdmin
                  ? "No MCP servers yet. Add one to give the agent read access to an external tool."
                  : "No MCP servers configured yet."}
              </EmptyState>
            )}
          </div>
          {isAdmin && (
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
          )}
        </SettingsCard>
      )}
    </>
  );
}
