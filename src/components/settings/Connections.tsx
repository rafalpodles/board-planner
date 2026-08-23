"use client";

import { useState } from "react";
import { ApiProject } from "@/types";
import { BrandIcon, type BrandId } from "@/components/ui/BrandIcon";
import { Button } from "@/components/ui/Button";

export type IntegrationId =
  "github" | "gitlab" | "coda" | "channels" | "webhooks";

interface Definition {
  id: IntegrationId;
  brand: BrandId;
  name: string;
  blurb: string;
  isConfigured: (project: ApiProject) => boolean;
  summary: (project: ApiProject) => string;
  /**
   * True when the repository URL already implies this connection. Such a row is never
   * offered in the picker — pasting the URL is what adds it.
   */
  impliedByRepository?: (project: ApiProject) => boolean;
}

export const INTEGRATIONS: Definition[] = [
  {
    id: "github",
    brand: "github",
    name: "GitHub",
    blurb: "Link pull requests to tasks by key",
    isConfigured: (p) => !!p.githubTokenSet,
    summary: (p) =>
      p.githubTokenSet ? "Linking pull requests" : "Needs an access token",
    impliedByRepository: (p) => p.repositoryProvider === "github",
  },
  {
    id: "gitlab",
    brand: "gitlab",
    name: "GitLab",
    blurb: "Link merge requests to tasks by key",
    isConfigured: (p) => !!p.gitlabTokenSet,
    summary: (p) =>
      p.gitlabTokenSet ? "Linking merge requests" : "Needs an access token",
    impliedByRepository: (p) => p.repositoryProvider === "gitlab",
  },
  {
    id: "coda",
    brand: "coda",
    name: "Coda",
    blurb: "Mirror tasks into a Coda table",
    isConfigured: (p) => !!p.codaDocId || !!p.codaTokenSet,
    summary: (p) => p.codaDocId || "Not configured yet",
  },
  {
    id: "channels",
    brand: "slack",
    name: "Slack & Discord",
    blurb: "Post board events to a channel",
    isConfigured: (p) => (p.notificationChannels?.length ?? 0) > 0,
    summary: (p) => {
      const n = p.notificationChannels?.length ?? 0;
      return n === 0 ? "No channels yet" : `${n} channel${n === 1 ? "" : "s"}`;
    },
  },
  {
    id: "webhooks",
    brand: "webhook",
    name: "Webhooks",
    blurb: "POST board events to any URL",
    isConfigured: (p) => (p.webhooks?.length ?? 0) > 0,
    summary: (p) => {
      const n = p.webhooks?.length ?? 0;
      return n === 0
        ? "No endpoints yet"
        : `${n} endpoint${n === 1 ? "" : "s"}`;
    },
  },
];

interface Props {
  project: ApiProject;
  /** Rows the user added by hand this session; the rest are derived from the project */
  opened: IntegrationId[];
  expanded: IntegrationId | null;
  onExpand: (id: IntegrationId | null) => void;
  onOpen: (id: IntegrationId) => void;
  onRemove: (id: IntegrationId) => void;
  renderBody: (id: IntegrationId) => React.ReactNode;
}

/**
 * One list. A row expands where it sits, so the thing you just added is under the button
 * you pressed — the previous shape put the summary in one card and the vendor's form in
 * another below it, and the two disagreed about what was connected.
 */
export function Connections({
  project,
  opened,
  expanded,
  onExpand,
  onOpen,
  onRemove,
  renderBody,
}: Props) {
  const [picking, setPicking] = useState(false);

  const visible = INTEGRATIONS.filter(
    (i) =>
      i.isConfigured(project) ||
      i.impliedByRepository?.(project) ||
      opened.includes(i.id),
  );
  // A repository URL adds GitHub or GitLab on its own, but they stay in the picker anyway:
  // dropping them meant someone looking for "GitHub" found nothing and concluded it was gone
  const available = INTEGRATIONS.filter(
    (i) => !visible.some((v) => v.id === i.id),
  );

  return (
    <section className="mb-4 rounded-xl border border-border bg-bg-card">
      <header className="border-b border-border px-4 py-3">
        <h3 className="text-[15px] font-semibold">Connections</h3>
        <p className="mt-0.5 text-sm text-text-muted">
          Where this board sends events, and what it reads back.
        </p>
      </header>

      <div className="divide-y divide-border">
        {visible.map((integration) => {
          const open = expanded === integration.id;
          const connected = integration.isConfigured(project);
          const implied = integration.impliedByRepository?.(project) ?? false;

          return (
            <div key={integration.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <BrandIcon
                  brand={integration.brand}
                  className="h-5 w-5 shrink-0"
                />
                <button
                  type="button"
                  onClick={() => onExpand(open ? null : integration.id)}
                  aria-expanded={open}
                  className="focus-ring min-w-0 flex-1 rounded text-left"
                >
                  <span className="block truncate text-sm font-medium">
                    {integration.name}
                  </span>
                  <span className="block truncate text-xs text-text-muted">
                    {integration.summary(project)}
                  </span>
                </button>

                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    connected
                      ? "bg-success/15 text-success"
                      : "bg-bg-input text-text-muted"
                  }`}
                >
                  {connected ? "Connected" : "Not set up"}
                </span>

                {/* An implied row cannot be removed here — clearing the repository URL is
                    what removes it, and a button that silently did nothing would be worse */}
                {!implied && !connected && (
                  <button
                    type="button"
                    onClick={() => onRemove(integration.id)}
                    aria-label={`Remove ${integration.name}`}
                    className="focus-ring shrink-0 inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-danger"
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onExpand(open ? null : integration.id)}
                  aria-label={`${open ? "Collapse" : "Configure"} ${integration.name}`}
                  className="focus-ring shrink-0 inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-text"
                >
                  {open ? "▴" : "▾"}
                </button>
              </div>

              {open && (
                <div className="space-y-4 px-4 pb-4">
                  {renderBody(integration.id)}
                </div>
              )}
            </div>
          );
        })}

        {visible.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-text-muted">
            Nothing connected yet. Paste a repository URL above, or add one of
            these:
          </p>
        )}
      </div>

      {available.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          {/* On an empty project the options are the fastest thing to show, so they are
              already open rather than hidden behind a button */}
          {picking || visible.length === 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((integration) => (
                <button
                  key={integration.id}
                  type="button"
                  onClick={() => {
                    onOpen(integration.id);
                    onExpand(integration.id);
                    setPicking(false);
                  }}
                  className="focus-ring flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <BrandIcon
                    brand={integration.brand}
                    className="h-5 w-5 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {integration.name}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {integration.blurb}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPicking(true)}
            >
              + Add integration
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
