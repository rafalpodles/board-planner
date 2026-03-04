"use client";

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiSprint, SprintStatus, SPRINT_STATUS_LABELS } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

export default function SprintsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { toast } = useToast();

  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ApiSprint | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [completeSprint, setCompleteSprint] = useState<ApiSprint | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadSprints() {
    try {
      const data = await api.get(`/api/projects/${projectId}/sprints`);
      setSprints(data);
    } catch {
      toast("Failed to load sprints", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSprints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openForm(sprint?: ApiSprint) {
    if (sprint) {
      setEditing(sprint);
      setName(sprint.name);
      setStartDate(sprint.startDate.substring(0, 10));
      setEndDate(sprint.endDate.substring(0, 10));
      setGoal(sprint.goal);
    } else {
      setEditing(null);
      setName("");
      // Default: start today, end in 2 weeks
      const today = new Date();
      const twoWeeks = new Date(today);
      twoWeeks.setDate(twoWeeks.getDate() + 14);
      setStartDate(today.toISOString().substring(0, 10));
      setEndDate(twoWeeks.toISOString().substring(0, 10));
      setGoal("");
    }
    setShowForm(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { name, startDate, endDate, goal };
      if (editing) {
        await api.put(`/api/projects/${projectId}/sprints/${editing._id}`, body);
        toast("Sprint updated", "success");
      } else {
        await api.post(`/api/projects/${projectId}/sprints`, body);
        toast("Sprint created", "success");
      }
      setShowForm(false);
      loadSprints();
    } catch {
      toast("Failed to save sprint", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(sprintId: string) {
    try {
      await api.put(`/api/projects/${projectId}/sprints/${sprintId}`, {
        status: "active",
      });
      toast("Sprint activated", "success");
      loadSprints();
    } catch {
      toast("Failed to activate sprint", "error");
    }
  }

  async function handleComplete(sprintId: string, moveToBacklog: boolean) {
    try {
      await api.put(`/api/projects/${projectId}/sprints/${sprintId}`, {
        status: "completed",
        moveIncompleteToBacklog: moveToBacklog,
      });
      toast("Sprint completed", "success");
      setCompleteSprint(null);
      loadSprints();
    } catch {
      toast("Failed to complete sprint", "error");
    }
  }

  async function handleDelete(sprintId: string) {
    try {
      await api.del(`/api/projects/${projectId}/sprints/${sprintId}`);
      toast("Sprint deleted", "success");
      setConfirmDelete(null);
      loadSprints();
    } catch {
      toast("Failed to delete sprint", "error");
    }
  }

  function statusBadge(status: SprintStatus) {
    const colors: Record<SprintStatus, string> = {
      planned: "bg-bg-input text-text-muted",
      active: "bg-primary/10 text-primary",
      completed: "bg-status-done/10 text-status-done",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status]}`}>
        {SPRINT_STATUS_LABELS[status]}
      </span>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/projects/${projectId}`)}
            className="text-text-muted hover:text-text transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold">Sprints</h1>
        </div>
        <Button size="sm" onClick={() => openForm()}>
          New Sprint
        </Button>
      </div>

      {sprints.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-text-muted mb-4">No sprints yet</p>
          <Button size="sm" onClick={() => openForm()}>Create your first sprint</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {sprints.map((sprint) => {
            const start = new Date(sprint.startDate);
            const end = new Date(sprint.endDate);
            const now = new Date();
            const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
            const elapsed = Math.max(0, Math.ceil((now.getTime() - start.getTime()) / 86400000));
            const timeProgress = Math.min(100, (elapsed / totalDays) * 100);
            const taskProgress = sprint.taskCount ? (sprint.doneCount! / sprint.taskCount) * 100 : 0;

            return (
              <div
                key={sprint._id}
                className="border border-border rounded-lg p-4 bg-bg-card"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">{sprint.name}</h3>
                      {statusBadge(sprint.status)}
                    </div>
                    {sprint.goal && (
                      <p className="text-sm text-text-muted">{sprint.goal}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {sprint.status === "planned" && (
                      <Button size="sm" variant="secondary" onClick={() => handleActivate(sprint._id)}>
                        Activate
                      </Button>
                    )}
                    {sprint.status === "active" && (
                      <Button size="sm" variant="secondary" onClick={() => setCompleteSprint(sprint)}>
                        Complete
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => openForm(sprint)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(sprint._id)}>
                      <svg className="w-4 h-4 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-text-muted mb-2">
                  <span>
                    {start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {" — "}
                    {end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                  <span>{totalDays} days</span>
                  <span>{sprint.doneCount}/{sprint.taskCount} tasks done</span>
                </div>

                {sprint.status === "active" && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-text-muted w-12">Time</span>
                      <div className="flex-1 h-1.5 bg-bg-input rounded-full overflow-hidden">
                        <div
                          className="h-full bg-text-muted/30 rounded-full transition-all"
                          style={{ width: `${timeProgress}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-text-muted w-8 text-right">
                        {Math.round(timeProgress)}%
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-text-muted w-12">Tasks</span>
                      <div className="flex-1 h-1.5 bg-bg-input rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${taskProgress}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-text-muted w-8 text-right">
                        {Math.round(taskProgress)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? "Edit Sprint" : "New Sprint"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint 1"
            required
          />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="w-full bg-bg-input border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <Input
            label="Goal (optional)"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What do we want to achieve?"
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : editing ? "Update" : "Create"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {completeSprint && (
        <Modal
          open={!!completeSprint}
          onClose={() => setCompleteSprint(null)}
          title="Complete Sprint"
        >
          <div className="space-y-4">
            <p className="text-sm">
              Completing <strong>{completeSprint.name}</strong>.
              {(completeSprint.taskCount! - completeSprint.doneCount!) > 0 && (
                <> There {completeSprint.taskCount! - completeSprint.doneCount! === 1 ? "is" : "are"}{" "}
                <strong>{completeSprint.taskCount! - completeSprint.doneCount!}</strong> incomplete
                task{completeSprint.taskCount! - completeSprint.doneCount! === 1 ? "" : "s"}.</>
              )}
            </p>
            <div className="flex gap-3">
              <Button onClick={() => handleComplete(completeSprint._id, true)}>
                Move to Backlog
              </Button>
              <Button variant="secondary" onClick={() => handleComplete(completeSprint._id, false)}>
                Keep in Sprint
              </Button>
              <Button variant="ghost" onClick={() => setCompleteSprint(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
        title="Delete Sprint"
        message="Are you sure? Tasks in this sprint will be moved to backlog."
        confirmLabel="Delete"
      />
    </div>
  );
}
