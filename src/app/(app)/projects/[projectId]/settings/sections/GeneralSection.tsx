"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/components/ui/Toast";
import { ApiMemberCandidate, ApiProjectMember, GrantRelation } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { IconPicker } from "@/components/ui/IconPicker";
import { SettingsCard, ListRow } from "@/components/settings/SettingsCard";
import { DangerAction } from "@/components/settings/DangerAction";
import { SettingRow } from "@/components/settings/SettingRow";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

// Matches the API, which refuses anything shorter
const MIN_QUERY = 2;

export function GeneralSection({ projectId, project, replaceProject, stats }: SectionProps) {
  const api = useApi();
  const router = useRouter();
  const { toast } = useToast();

  const identity = useDraft({
    name: project.name,
    description: project.description,
    icon: project.icon || "",
  });

  const [members, setMembers] = useState<ApiProjectMember[]>([]);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<ApiMemberCandidate[]>([]);
  const trimmedCandidateQuery = candidateQuery.trim();

  useEffect(() => {
    if (trimmedCandidateQuery.length < MIN_QUERY) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await api.get(
          `/api/projects/${projectId}/members/candidates?q=${encodeURIComponent(trimmedCandidateQuery)}`
        );
        if (!cancelled) setCandidates(data);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmedCandidateQuery, projectId]);

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

  async function setRelation(userId: string, relation: GrantRelation | "none") {
    try {
      if (relation === "none") {
        await api.del(`/api/projects/${projectId}/members?userId=${userId}`);
      } else {
        await api.put(`/api/projects/${projectId}/members`, { userId, relation });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update access", "error");
      return;
    }

    // The row carries the change the server made, so a refresh that fails leaves it right rather
    // than showing the relation that was replaced — the select reads from this list (BP-583)
    setMembers((prev) =>
      prev.map((m) =>
        m._id === userId ? { ...m, relation: relation === "none" ? null : relation } : m
      )
    );
    toast("Access updated", "success");

    // Its own failure is not the write's: the access change landed
    try {
      setMembers(await api.get(`/api/projects/${projectId}/members`));
    } catch {
      toast(LIST_REFRESH_FAILED, "error");
    }
  }

  async function addMember(userId: string) {
    await setRelation(userId, "member");
    setCandidateQuery("");
    setCandidates([]);
  }

  async function handleDelete() {
    try {
      await api.del(`/api/projects/${projectId}`);
      router.replace("/projects");
    } catch {
      toast("Failed to delete project", "error");
    }
  }

  return (
    <>
      <SettingsCard
        title="Identity"
        description="How this project appears in the sidebar, search and the board header."
      >
        <div>
          <SettingRow label="Name" hint="Shown everywhere the project is listed">
            <Input
              value={identity.value.name}
              aria-label="Project name"
              dirty={identity.isDirty("name")}
              onChange={(e) => identity.set("name", e.target.value)}
              required
            />
          </SettingRow>
          <SettingRow label="Icon" hint="Sidebar, project cards, search results">
            <IconPicker
              label="Project icon"
              value={identity.value.icon}
              dirty={identity.isDirty("icon")}
              onChange={(v) => identity.set("icon", v)}
            />
          </SettingRow>
          <SettingRow label="Key" hint="Task keys are built from this and cannot change">
            <Input value={project.key} aria-label="Project key" disabled className="max-w-[160px]" />
          </SettingRow>
          <SettingRow label="Description" hint="One line under the board title">
            <Textarea
              value={identity.value.description}
              aria-label="Project description"
              dirty={identity.isDirty("description")}
              onChange={(e) => identity.set("description", e.target.value)}
            />
          </SettingRow>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Who can use this board"
        description="Owners can change everything on this page. Members work on tasks and sprints. Instance admins always have full access and are listed for reference."
      >
        <div className="space-y-3">
          <div className="relative">
            <Input
              value={candidateQuery}
              onChange={(e) => setCandidateQuery(e.target.value)}
              placeholder="Add a person by username or name…"
              aria-label="Add person"
            />
            {trimmedCandidateQuery.length >= MIN_QUERY && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-bg-card shadow-lg">
                {candidates.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-muted">No matches</p>
                ) : (
                  candidates.map((c) => (
                    <button
                      key={c._id}
                      type="button"
                      onClick={() => addMember(c._id)}
                      className="focus-ring block w-full px-3 py-2 text-left text-sm hover:bg-bg-hover"
                    >
                      {c.fullName || c.username}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            {members.map((m) => (
              <ListRow key={m._id}>
                <span className="flex-1 text-sm font-medium">{m.fullName || m.username}</span>
                {m.instanceAdmin ? (
                  <span className="text-sm text-text-muted">Instance admin</span>
                ) : (
                  <select
                    value={m.relation ?? "none"}
                    onChange={(e) => setRelation(m._id, e.target.value as GrantRelation | "none")}
                    className="focus-ring rounded-lg border border-border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0"
                    aria-label={`Access for ${m.username}`}
                  >
                    <option value="none">No access</option>
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                  </select>
                )}
              </ListRow>
            ))}
          </div>
        </div>
      </SettingsCard>

      {project.canAdmin && (
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
