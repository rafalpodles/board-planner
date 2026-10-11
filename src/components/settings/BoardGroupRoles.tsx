"use client";

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard, ListRow } from "@/components/settings/SettingsCard";
import type { GroupRole } from "@/types";

interface Answer {
  map: GroupRole[];
  hasProvider: boolean;
}

const same = (a: GroupRole[], b: GroupRole[]) => a.length === b.length && a.every((row, i) => row.group === b[i].group && row.role === b[i].role);

export function BoardGroupRoles({ projectId }: { projectId: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [rows, setRows] = useState<GroupRole[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const read: Answer = await api.get(`/api/projects/${projectId}/group-roles`);
      setAnswer(read);
      setRows(read.map);
    } catch {
      setFailed(true);
    }
  }, [api, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) return <LoadFailed testId="group-roles-error" message="Failed to read the group mapping." onRetry={load} />;
  // Nothing to map where there is no provider to read groups from, unless something is mapped already
  if (!answer || (!answer.hasProvider && answer.map.length === 0)) return null;

  const dirty = !same(rows, answer.map);
  const complete = rows.every((row) => row.group.trim() !== "");

  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved: Answer = await api.put(`/api/projects/${projectId}/group-roles`, { map: rows.map((row) => ({ group: row.group.trim(), role: row.role })) });
      setAnswer(saved);
      setRows(saved.map);
      toast("Group mapping saved", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Roles from identity provider groups"
      description="At each sign-in through your identity provider, a person in a group below gets that role on this board. Leaving the group removes only what the group gave: a role set by hand is never touched, and the last owner is never removed. It is read at sign-in only."
    >
      <div className="space-y-2" data-testid="group-roles">
        {rows.map((row, i) => (
          <ListRow key={i}>
            <Input
              label="Group"
              value={row.group}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, group: e.target.value } : r)))}
              maxLength={200}
              spellCheck={false}
              autoComplete="off"
              placeholder="engineering"
            />
            <select
              aria-label={`Role for ${row.group || "the new group"}`}
              value={row.role}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, role: e.target.value as GroupRole["role"] } : r)))}
              className="focus-ring rounded-lg border border-border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0"
            >
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
            <Button type="button" variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${row.group || "the new group"}`}>
              Remove
            </Button>
          </ListRow>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy || rows.length >= 50} onClick={() => setRows([...rows, { group: "", role: "member" }])}>
          Add a group
        </Button>
        <Button type="button" disabled={busy || !dirty || !complete} onClick={save}>
          {busy ? "Saving…" : "Save group mapping"}
        </Button>
      </div>
    </SettingsCard>
  );
}
