// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useEntitlement } from "@/hooks/use-entitlement";
import { clearsStoredToken } from "@/lib/host-bound-secrets";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ProUpsell } from "@/components/ui/ProUpsell";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";
import { CODA_COLUMNS, CODA_KEY_COLUMN } from "./client";

const DEFAULT_HOST = "https://coda.io";

type CodaDraft = ReturnType<typeof useCodaDraft>;

function useCodaDraft(project: ApiProject) {
  return useDraft({
    codaDocId: project.codaDocId || "",
    codaTableId: project.codaTableId || "",
    codaHost: project.codaHost || DEFAULT_HOST,
    codaToken: "",
  });
}

/** Owned by the integrations section, so an unsaved edit survives switching to another integration. */
export function useCodaSettings({
  project,
  replaceAndReturn,
  fail,
}: {
  project: ApiProject;
  replaceAndReturn: (payload: Record<string, string>) => Promise<ApiProject>;
  fail: (err: unknown, fallback: string) => void;
}): CodaDraft {
  const { toast } = useToast();
  const coda = useCodaDraft(project);

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
          if (coda.value.codaToken.trim()) payload.codaToken = coda.value.codaToken.trim();
          const updated = await replaceAndReturn(payload);
          coda.commit({
            codaDocId: updated.codaDocId || "",
            codaTableId: updated.codaTableId || "",
            codaHost: updated.codaHost || DEFAULT_HOST,
            codaToken: "",
          });
          toast("Coda settings saved", "success");
        } catch (err) {
          fail(err, "Failed to save Coda settings");
        }
      },
      discard: coda.discard,
    }
  );

  return coda;
}

export function CodaPanel({
  projectId,
  project,
  coda,
  replaceProject,
  fail,
}: {
  projectId: string;
  project: ApiProject;
  coda: CodaDraft;
  replaceProject: (next: ApiProject) => void;
  fail: (err: unknown, fallback: string) => void;
}) {
  const { loading, entitled } = useEntitlement("integrations.coda");
  if (loading) return null;
  if (!entitled) return <CodaOnFree project={project} />;
  return <CodaForm projectId={projectId} project={project} coda={coda} replaceProject={replaceProject} fail={fail} />;
}

function CodaOnFree({ project }: { project: ApiProject }) {
  const configured = !!(project.codaDocId || project.codaTokenSet);
  return (
    <>
      <ProUpsell feature="Coda sync">
        Mirroring this board into a Coda table is part of Board Planner Pro.
      </ProUpsell>
      {configured && (
        <>
          <dl className="divide-y divide-border rounded-lg border border-border text-sm" data-testid="coda-kept">
            {[
              ["Doc ID", project.codaDocId || "—"],
              ["Table", project.codaTableId || "—"],
              ["Host", project.codaHost || DEFAULT_HOST],
              ["API token", project.codaTokenSet ? "Set" : "Not set"],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-4 px-4 py-2">
                <dt className="w-24 shrink-0 text-text-muted sm:w-48">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-text-muted">
            This board&apos;s Coda settings are kept as they are. Syncing resumes once the instance is on Pro again.
          </p>
        </>
      )}
    </>
  );
}

function CodaForm({
  projectId,
  project,
  coda,
  replaceProject,
  fail,
}: {
  projectId: string;
  project: ApiProject;
  coda: CodaDraft;
  replaceProject: (next: ApiProject) => void;
  fail: (err: unknown, fallback: string) => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);

  return (
    <>
      <p className="text-sm text-text-muted">Mirrors this board into a Coda table. One-way: Coda never writes back.</p>
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
        placeholder={DEFAULT_HOST}
      />
      {project.codaTokenSet &&
        clearsStoredToken(coda.value.codaHost, coda.baseline.codaHost, coda.value.codaToken, DEFAULT_HOST) && (
          <p className="text-sm text-warning">
            The stored token was issued for the old host. Saving a new host clears it — enter the token for the new
            host below, or it will have to be re-entered before the next sync.
          </p>
        )}
      <Input
        label="API token"
        type="password"
        value={coda.value.codaToken}
        dirty={coda.isDirty("codaToken")}
        onChange={(e) => coda.set("codaToken", e.target.value)}
        placeholder={project.codaTokenSet ? "Set — enter a new token to replace" : "Coda API token"}
      />
      <p className="text-xs text-text-muted">
        The table must already have these columns: {CODA_COLUMNS.join(", ")}. Rows are matched on {CODA_KEY_COLUMN}, so
        syncing twice updates instead of duplicating.
      </p>
      <div className="flex flex-wrap gap-2">
        {project.codaTokenSet && project.codaDocId && project.codaTableId && (
          <Button
            size="sm"
            variant="secondary"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                const result = await api.post(`/api/projects/${projectId}/coda/sync`, {});
                toast(
                  result.allApplied
                    ? `Synced ${result.tasksPushed} tasks to Coda`
                    : `Sent ${result.tasksPushed} tasks — Coda is still applying them`,
                  result.allApplied ? "success" : "info"
                );
              } catch (err) {
                fail(err, "Coda sync failed");
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? "Syncing..." : "Sync tasks now"}
          </Button>
        )}
        {(project.codaTokenSet || project.codaDocId) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const cleared = { codaDocId: "", codaTableId: "", codaHost: DEFAULT_HOST, codaToken: "" };
              try {
                replaceProject(await api.put(`/api/projects/${projectId}`, cleared));
                coda.commit(cleared);
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
}
