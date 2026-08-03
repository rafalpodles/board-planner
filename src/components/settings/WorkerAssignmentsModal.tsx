"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ApiWorker } from "@/types";
import {
  AssignmentDraft,
  assignmentProblem,
  describeProblem,
  hasChanged,
  withAssignment,
  withoutAssignment,
} from "@/lib/worker-assignments-view";

interface ProjectOption {
  _id: string;
  key: string;
  name: string;
}

interface WorkerAssignmentsModalProps {
  worker: ApiWorker | null;
  onClose: () => void;
  onSaved: () => void;
}

export function WorkerAssignmentsModal({ worker, onClose, onSaved }: WorkerAssignmentsModalProps) {
  const api = useApi();
  const { toast } = useToast();

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [drafts, setDrafts] = useState<AssignmentDraft[]>([]);
  const [project, setProject] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!worker) return;
    setDrafts(worker.assignments.map((a) => ({ ...a })));
    setProject("");
    setPath("");
    setError(null);
    api
      .get("/api/projects")
      .then(setProjects)
      .catch(() => setProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker?._id]);

  if (!worker) return null;

  const original = worker.assignments.map((a) => ({ ...a }));
  const labelFor = (id: string) => {
    const found = projects.find((p) => p._id === id);
    return found ? `${found.key} — ${found.name}` : id;
  };

  function add() {
    const problem = assignmentProblem(drafts, { project, proposedPath: path });
    if (problem) {
      setError(describeProblem(problem));
      return;
    }
    setDrafts(withAssignment(drafts, { project, proposedPath: path }));
    setProject("");
    setPath("");
    setError(null);
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/workers/${worker!._id}`, { assignments: drafts });
      toast("Assignments saved", "success");
      onSaved();
      onClose();
    } catch (err) {
      // The server refuses a checkout another live worker already holds; that message names the
      // other machine and is far more useful than anything this component could invent.
      setError(err instanceof Error ? err.message : "Could not save assignments");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Assignments — ${worker.name}`} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          A path here is a <em>proposal</em>. The worker binds it only if the operator has already
          listed it in <code className="text-text">repos.json</code> on that machine, so the server
          can never point a worker at a directory of its choosing.
        </p>

        {drafts.length === 0 ? (
          <p className="text-sm text-text-muted">This worker serves no project yet.</p>
        ) : (
          <ul className="border border-border rounded-lg divide-y divide-border">
            {drafts.map((d) => (
              <li key={d.project} className="flex items-center gap-3 px-3 py-2">
                <span className="text-sm font-medium whitespace-nowrap">{labelFor(d.project)}</span>
                <code className="flex-1 text-xs text-text-muted truncate">{d.proposedPath}</code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDrafts(withoutAssignment(drafts, d.project))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="block mb-1 text-text-muted">Project</span>
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="w-full bg-bg-input border border-border rounded px-2 py-1.5 text-sm"
            >
              <option value="">Choose…</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex-[2]">
            <Input
              label="Repository path on the worker's machine"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/code/the-repo"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </div>
          <Button variant="secondary" onClick={add}>
            Add
          </Button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !hasChanged(original, drafts)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
