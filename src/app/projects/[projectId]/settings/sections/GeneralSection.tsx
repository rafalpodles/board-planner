"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { ApiProjectMember, PROJECT_ICONS, DEFAULT_PROJECT_ICON } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { EmojiPicker } from "@/components/ui/EmojiPicker";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsCard, ListRow } from "@/components/settings/SettingsCard";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

export function GeneralSection({ projectId, project, replaceProject, isAdmin }: SectionProps) {
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}`);
      router.replace("/projects");
    } catch {
      toast("Failed to delete project", "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const ownerName = typeof project.owner === "object" ? project.owner.username : "unknown";
  const ownerId = typeof project.owner === "object" ? project.owner._id : project.owner;

  return (
    <>
      <SettingsCard title="Identity" contract="draft">
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
        <EmojiPicker
          label="Icon"
          value={identity.value.icon}
          options={PROJECT_ICONS}
          fallback={DEFAULT_PROJECT_ICON}
          onChange={(v) => identity.set("icon", v)}
        />
        <Textarea
          label="Description"
          value={identity.value.description}
          dirty={identity.isDirty("description")}
          onChange={(e) => identity.set("description", e.target.value)}
        />
      </SettingsCard>

      <SettingsCard
        title="Who can change settings"
        contract="live"
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
          description={`Deletes ${project.name} and all its tasks, comments and history. This can't be undone.`}
        >
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete project
          </Button>
        </SettingsCard>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete Project"
        message={`Are you sure you want to delete "${project.name}" and all its tasks? This action cannot be undone.`}
        confirmLabel="Delete Project"
        loading={deleting}
      />
    </>
  );
}
