"use client";

import { useEffect, useRef, useState } from "react";
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
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { SectionProps } from "./types";

// Matches the API, which refuses anything shorter
const MIN_QUERY = 2;

type Access = GrantRelation | "none";

// Grants before removals, so handing ownership over never leaves the board without an owner in
// between — the server refuses that step. The reader's own change goes after all of them: once it
// lands they may own the board no more, and everything sent after it would be refused.
const APPLY_ORDER: Record<Access, number> = { owner: 0, member: 1, none: 2 };
const OWN_CHANGE = 3;

function withAccessApplied(
  rows: ApiProjectMember[],
  id: string,
  relation: Access,
  newcomer: ApiMemberCandidate | undefined
): ApiProjectMember[] {
  if (relation === "none") return rows.filter((m) => m._id !== id);
  if (rows.some((m) => m._id === id)) {
    return rows.map((m) => (m._id === id ? { ...m, relation } : m));
  }
  return newcomer ? [...rows, { ...newcomer, relation, instanceAdmin: false }] : rows;
}

export function GeneralSection({
  projectId,
  project,
  replaceProject,
  isAdmin,
  currentUserId,
  stats,
}: SectionProps) {
  const api = useApi();
  const router = useRouter();
  const { toast } = useToast();

  const identity = useDraft({
    name: project.name,
    description: project.description ?? "",
    icon: project.icon || "",
  });

  const [members, setMembers] = useState<ApiProjectMember[]>([]);
  // Nothing on the list can be changed before it has been read: a change made on a list still
  // empty was applied to that empty list, and the people it did not touch vanished (BP-784)
  const [membersRead, setMembersRead] = useState<"loading" | "loaded" | "failed">("loading");
  const latestMembersRead = useRef(0);

  async function loadMembers() {
    const read = ++latestMembersRead.current;
    try {
      const loaded: ApiProjectMember[] = await api.get(`/api/projects/${projectId}/members`);
      if (read !== latestMembersRead.current) return;
      setMembers(loaded);
      setMembersRead("loaded");
    } catch (error) {
      if (read === latestMembersRead.current) {
        setMembersRead((state) => (state === "loaded" ? state : "failed"));
      }
      throw error;
    }
  }

  function readMembers() {
    setMembersRead((state) => (state === "loaded" ? state : "loading"));
    loadMembers().catch(() => {});
  }

  useEffect(() => {
    readMembers();
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

  // Only what differs from the list on screen: staged like the rest of the page (BP-741)
  const [accessEdits, setAccessEdits] = useState<Record<string, Access>>({});
  const [newcomers, setNewcomers] = useState<Record<string, ApiMemberCandidate>>({});
  const [savingAccess, setSavingAccess] = useState(false);

  function chooseAccess(userId: string, relation: Access) {
    const current = members.find((m) => m._id === userId)?.relation ?? "none";
    setAccessEdits((prev) => {
      const next = { ...prev };
      if (relation === current) delete next[userId];
      else next[userId] = relation;
      return next;
    });
  }

  function addMember(candidate: ApiMemberCandidate) {
    setNewcomers((prev) => ({ ...prev, [candidate._id]: candidate }));
    chooseAccess(candidate._id, "member");
    setCandidateQuery("");
    setCandidates([]);
  }

  function nameOf(userId: string) {
    const person = members.find((m) => m._id === userId) ?? newcomers[userId];
    return person ? person.fullName || person.username : userId;
  }

  async function saveAccess() {
    const order = (userId: string, relation: Access) =>
      userId === currentUserId ? OWN_CHANGE : APPLY_ORDER[relation];
    const sent = Object.entries(accessEdits).sort(([a, ra], [b, rb]) => order(a, ra) - order(b, rb));
    const refused: string[] = [];
    let landed = 0;
    let ownLanded: Access | null = null;

    setSavingAccess(true);
    try {
      for (const [userId, relation] of sent) {
        // Sent now, it would take the page — and the refused change with it — out of reach
        if (userId === currentUserId && refused.length > 0) {
          refused.push("Your own access was left as it is until the refused changes are saved");
          continue;
        }
        try {
          if (relation === "none") {
            await api.del(`/api/projects/${projectId}/members?userId=${userId}`);
          } else {
            await api.put(`/api/projects/${projectId}/members`, { userId, relation });
          }
        } catch (err) {
          refused.push(
            `${nameOf(userId)}: ${err instanceof Error ? err.message : "Failed to update access"}`
          );
          continue;
        }
        landed++;
        if (userId === currentUserId) ownLanded = relation;
        setAccessEdits((prev) => {
          if (prev[userId] !== relation) return prev;
          const next = { ...prev };
          delete next[userId];
          return next;
        });
        // The row carries what the server did even if the re-read below fails. A revocation drops
        // it: `GET …/members` never returns a non-admin holding no relation (BP-592)
        setMembers((prev) => withAccessApplied(prev, userId, relation, newcomers[userId]));
      }
    } finally {
      setSavingAccess(false);
    }

    if (refused.length > 0) toast(refused.join(" · "), "error");
    if (landed === 0) return;
    if (refused.length === 0) toast("Access updated", "success");

    // Stepping down changes what this page may show, and the members list is an owner's to read
    if (ownLanded && !isAdmin) {
      if (ownLanded === "none") {
        router.replace("/projects");
        return;
      }
      try {
        replaceProject(await api.get(`/api/projects/${projectId}`));
      } catch {
        toast(LIST_REFRESH_FAILED, "error");
      }
      return;
    }

    // Its own failure is not the write's: the access change landed (BP-583)
    try {
      await loadMembers();
    } catch {
      toast(LIST_REFRESH_FAILED, "error");
    }
  }

  useDirtyGroup(
    {
      id: "general-access",
      section: "general",
      label: "General · Access",
      count: Object.keys(accessEdits).length,
      saveLast: true,
    },
    { save: saveAccess, discard: () => setAccessEdits({}) }
  );

  // Somebody already listed — an instance admin among them — or already pending has nothing to add
  const offered = candidates.filter(
    (c) => !members.some((m) => m._id === c._id) && !(c._id in accessEdits)
  );

  const pendingNewcomers = Object.keys(accessEdits)
    .filter((id) => !members.some((m) => m._id === id) && newcomers[id])
    .map((id): ApiProjectMember => ({ ...newcomers[id], relation: null, instanceAdmin: false }));

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
        {membersRead === "loading" && (
          <p role="status" className="text-sm text-text-muted">
            Loading who can use this board…
          </p>
        )}
        {membersRead === "failed" && (
          <LoadFailed
            variant="row"
            className="mb-0"
            message="Could not load who can use this board."
            onRetry={readMembers}
          />
        )}
        {membersRead === "loaded" && (
        <div className="space-y-3">
          <div className="relative">
            <Input
              value={candidateQuery}
              onChange={(e) => setCandidateQuery(e.target.value)}
              placeholder="Add a person by username or name…"
              aria-label="Add person"
              disabled={savingAccess}
            />
            {trimmedCandidateQuery.length >= MIN_QUERY && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-bg-card shadow-lg">
                {offered.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-muted">
                    {candidates.length > 0 ? "Already on the list" : "No matches"}
                  </p>
                ) : (
                  offered.map((c) => (
                    <button
                      key={c._id}
                      type="button"
                      disabled={savingAccess}
                      onClick={() => addMember(c)}
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
            {[...members, ...pendingNewcomers].map((m) => (
              <ListRow key={m._id}>
                <span className="flex-1 text-sm font-medium">{m.fullName || m.username}</span>
                {m.instanceAdmin ? (
                  <span className="text-sm text-text-muted">Instance admin</span>
                ) : (
                  <select
                    value={accessEdits[m._id] ?? m.relation ?? "none"}
                    disabled={savingAccess}
                    onChange={(e) => chooseAccess(m._id, e.target.value as Access)}
                    className={`focus-ring rounded-lg border bg-bg-input min-h-11 px-2 py-1.5 text-sm sm:min-h-0 ${
                      m._id in accessEdits ? "border-warning/60" : "border-border"
                    }`}
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
        )}
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
