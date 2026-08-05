"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { ApiProjectMember } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { IconPicker } from "@/components/ui/IconPicker";
import { SettingsCard, ListRow } from "@/components/settings/SettingsCard";
import { DangerAction } from "@/components/settings/DangerAction";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

export function GeneralSection({ projectId, project, replaceProject, isAdmin, stats }: SectionProps) {
  const api = useApi();
  const router = useRouter();
  const { toast } = useToast();

  const identity = useDraft({
    name: project.name,
    description: project.description,
    icon: project.icon || "",
  });

  const [members, setMembers] = useState<ApiProjectMember[]>([]);
  const [newAdminId, setNewAdminId] = useState("");
  const [adminsSaving, setAdminsSaving] = useState(false);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useDirtyGroup(
    { id: "general-identity", section: "general", label: "General · Identity", count: identity.count },
    {
      save: async () => {
        try {
          const updated = await api.put(`/api/projects/${projectId}`, identity.value);
          replaceProject(updated);
          identity.commit({
            name: updated.name,
            description: updated.description,
            icon: updated.icon || "",
          });
          toast("Changes saved", "success");
        } catch (err) {
          toast(err instanceof Error ? err.message : "Failed to save", "error");
        }
      },
      discard: identity.discard,
    }
  );

  async function saveAdmins(nextIds: string[]) {
    setAdminsSaving(true);
    try {
      replaceProject(await api.put(`/api/projects/${projectId}`, { admins: nextIds }));
      toast("Admins updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update admins", "error");
    } finally {
      setAdminsSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await api.del(`/api/projects/${projectId}`);
      router.replace("/projects");
    } catch {
      toast("Failed to delete project", "error");
    }
  }

  const ownerName = typeof project.owner === "object" ? project.owner.username : "unknown";
  const ownerId = typeof project.owner === "object" ? project.owner._id : project.owner;

  return (
    <>
      <SettingsCard title="Identity">
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Input
            label="Name"
            value={identity.value.name}
            dirty={identity.isDirty("name")}
            onChange={(e) => identity.set("name", e.target.value)}
            required
          />
          <div>
            <Input label="Key" value={project.key} disabled />
            <p className="mt-1 text-xs text-text-muted">Task keys use it. Can&apos;t change.</p>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-text-muted">Icon</label>
          <IconPicker
            label="Project icon"
            value={identity.value.icon}
            dirty={identity.isDirty("icon")}
            onChange={(v) => identity.set("icon", v)}
          />
        </div>
        <Textarea
          label="Description"
          value={identity.value.description}
          dirty={identity.isDirty("description")}
          onChange={(e) => identity.set("description", e.target.value)}
        />
      </SettingsCard>

      <SettingsCard
        title="Who can change settings"
        description="Project admins can edit everything on this page except the instance settings. The owner is always an admin."
      >
        <div className="space-y-2">
          <ListRow>
            <span className="text-sm font-medium">{ownerName}</span>
            <span className="rounded bg-bg-input px-2 py-0.5 text-xs text-text-muted">owner</span>
          </ListRow>
          {(project.admins || []).map((admin) => (
            <ListRow key={admin._id}>
              <span className="flex-1 text-sm font-medium">{admin.username}</span>
              <button
                onClick={() =>
                  saveAdmins((project.admins || []).filter((a) => a._id !== admin._id).map((a) => a._id))
                }
                disabled={adminsSaving}
                className="px-2 py-1 text-xs text-text-muted hover:text-danger"
              >
                Remove
              </button>
            </ListRow>
          ))}
        </div>
        <div className="flex gap-2">
          <select
            value={newAdminId}
            onChange={(e) => setNewAdminId(e.target.value)}
            className="min-h-[44px] flex-1 rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
          >
            <option value="">Add an admin...</option>
            {members
              .filter(
                (m) =>
                  m.role !== "admin" &&
                  m._id !== ownerId &&
                  !(project.admins || []).some((a) => a._id === m._id)
              )
              .map((m) => (
                <option key={m._id} value={m._id}>
                  {m.fullName ? `${m.fullName} (${m.username})` : m.username}
                </option>
              ))}
          </select>
          <Button
            variant="secondary"
            disabled={!newAdminId || adminsSaving}
            onClick={async () => {
              await saveAdmins([...(project.admins || []).map((a) => a._id), newAdminId]);
              setNewAdminId("");
            }}
          >
            Add
          </Button>
        </div>
      </SettingsCard>

      {isAdmin && (
        <SettingsCard
          title="Delete project"
          danger
          description={`Removes ${project.name}, its tasks, sprints and comments. This can't be undone.`}
        >
          <DangerAction
            label="Delete project..."
            title={`Delete "${project.name}"?`}
            message="The project, its sprints, its comments and its history go with it."
            usage={
              stats
                ? `${stats.total === 1 ? "1 task" : `${stats.total} tasks`} will be deleted and cannot be restored.`
                : undefined
            }
            confirmLabel="Delete project"
            onConfirm={handleDelete}
          />
        </SettingsCard>
      )}
    </>
  );
}
