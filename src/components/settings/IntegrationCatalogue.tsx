"use client";

import { useState } from "react";
import { ApiProject } from "@/types";
import { BrandIcon, type BrandId } from "@/components/ui/BrandIcon";
import { Button } from "@/components/ui/Button";

export type IntegrationId = "github" | "gitlab" | "coda" | "channels" | "webhooks";

interface Definition {
  id: IntegrationId;
  brand: BrandId;
  name: string;
  blurb: string;
  /** What a configured one looks like, so the list can be built from the project alone */
  isConfigured: (project: ApiProject) => boolean;
  summary: (project: ApiProject) => string;
}

export const INTEGRATIONS: Definition[] = [
  {
    id: "github",
    brand: "github",
    name: "GitHub",
    blurb: "Link pull requests to tasks by key",
    isConfigured: (p) => !!p.githubRepo || !!p.githubTokenSet,
    summary: (p) => p.githubRepo || "Connected",
  },
  {
    id: "gitlab",
    brand: "gitlab",
    name: "GitLab",
    blurb: "Link merge requests to tasks by key",
    isConfigured: (p) => !!p.gitlabRepo || !!p.gitlabTokenSet,
    summary: (p) => p.gitlabRepo || "Connected",
  },
  {
    id: "coda",
    brand: "coda",
    name: "Coda",
    blurb: "Mirror tasks into a Coda table",
    isConfigured: (p) => !!p.codaDocId || !!p.codaTokenSet,
    summary: (p) => p.codaDocId || "Connected",
  },
  {
    id: "channels",
    brand: "slack",
    name: "Slack & Discord",
    blurb: "Post board events to a channel",
    isConfigured: (p) => (p.notificationChannels?.length ?? 0) > 0,
    summary: (p) => {
      const n = p.notificationChannels?.length ?? 0;
      return `${n} channel${n === 1 ? "" : "s"}`;
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
      return `${n} endpoint${n === 1 ? "" : "s"}`;
    },
  },
];

interface Props {
  project: ApiProject;
  opened: IntegrationId[];
  onOpen: (id: IntegrationId) => void;
}

/**
 * The list of what is connected, and one button to add more.
 *
 * Every vendor used to render its whole form whether or not the project used it —
 * five stacked forms and about fifteen controls on a project with nothing configured.
 */
export function IntegrationCatalogue({ project, opened, onOpen }: Props) {
  const [picking, setPicking] = useState(false);

  const configured = INTEGRATIONS.filter((i) => i.isConfigured(project));
  const available = INTEGRATIONS.filter(
    (i) => !i.isConfigured(project) && !opened.includes(i.id)
  );

  return (
    <div className="mb-4 rounded-xl border border-border bg-bg-card p-4">
      <h3 className="text-sm font-semibold">Connections</h3>
      <p className="mt-0.5 text-sm text-text-muted">
        Only what you have added is shown. Everything else lives behind the button below.
      </p>

      <div className="mt-3 space-y-2">
        {configured.map((integration) => (
          <div
            key={integration.id}
            className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
          >
            <BrandIcon brand={integration.brand} className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{integration.name}</div>
              <div className="truncate text-xs text-text-muted">
                {integration.summary(project)}
              </div>
            </div>
            <span className="ml-auto rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
              Connected
            </span>
          </div>
        ))}

        {configured.length === 0 && opened.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-text-muted">
            Nothing connected yet.
          </p>
        )}
      </div>

      {available.length > 0 && (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
            + Add integration
          </Button>

          {picking && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {available.map((integration) => (
                <button
                  key={integration.id}
                  type="button"
                  onClick={() => {
                    onOpen(integration.id);
                    setPicking(false);
                  }}
                  className="focus-ring flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <BrandIcon brand={integration.brand} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{integration.name}</span>
                    <span className="block text-xs text-text-muted">{integration.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
