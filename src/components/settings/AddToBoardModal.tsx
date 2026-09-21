"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useProjects } from "@/hooks/use-projects";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { GrantRelation } from "@/types";

export function AddToBoardModal({
  person,
  onClose,
}: {
  person: { _id: string; fullName: string } | null;
  onClose: () => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const { projects, loadFailed, retrying, reload } = useProjects();
  const [projectId, setProjectId] = useState("");
  const [relation, setRelation] = useState<GrantRelation>("member");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!person) return;
    setProjectId(projects[0]?._id ?? "");
    setRelation("member");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person]);

  useEffect(() => {
    if (person && !projectId && projects.length > 0) setProjectId(projects[0]._id);
  }, [person, projectId, projects]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!person || !projectId || saving) return;
    setSaving(true);
    setError("");
    try {
      await api.put(`/api/projects/${projectId}/members`, { userId: person._id, relation });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them to the board");
      setSaving(false);
      return;
    }
    setSaving(false);
    const board = projects.find((p) => p._id === projectId)?.name ?? "the board";
    toast(
      `${person.fullName} is now ${relation === "owner" ? "an owner" : "a member"} of ${board}`,
      "success"
    );
    onClose();
  }

  return (
    <Modal
      open={!!person}
      onClose={onClose}
      closeDisabled={saving}
      title={person ? `Add ${person.fullName} to a board` : ""}
    >
      {loadFailed ? (
        <LoadFailed message="The boards could not be loaded." onRetry={reload} busy={retrying} />
      ) : projects.length === 0 ? (
        <p className="text-sm text-text-muted">
          There is no board yet.{" "}
          <Link href="/projects/new" className="text-primary underline" onClick={onClose}>
            Create the first one
          </Link>
          , then add people from its Settings → General.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Select
            label="Board"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            options={projects.map((p) => ({ value: p._id, label: `${p.name} (${p.key})` }))}
          />
          <Select
            label="Role"
            value={relation}
            onChange={(e) => setRelation(e.target.value as GrantRelation)}
            options={[
              { value: "member", label: "Member — works on tasks and sprints" },
              { value: "owner", label: "Owner — can also change the board's settings" },
            ]}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !projectId}>
              {saving ? "Adding…" : "Add to board"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
