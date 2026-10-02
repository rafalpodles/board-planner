"use client";

import { FormEvent, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useProjects } from "@/hooks/use-projects";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { InvitationLink } from "@/components/settings/InvitationLink";
import { ApiInvitation, GrantRelation, InvitationDelivery } from "@/types";

type Sent = { invitation: ApiInvitation } & InvitationDelivery;

const ROLE_BUTTON = "px-4 py-2 rounded-lg text-sm border transition-colors";
const ROLE_ON = "border-primary bg-primary/20 text-primary";
const ROLE_OFF = "border-border text-text-muted hover:border-text";

export function InviteModal({
  open,
  onClose,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const api = useApi();
  const { projects, loadFailed, retrying, reload } = useProjects();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [boards, setBoards] = useState<Record<string, GrantRelation>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  function close() {
    setEmail("");
    setRole("member");
    setBoards({});
    setError("");
    setSent(null);
    onClose();
  }

  function toggleBoard(id: string) {
    setBoards((current) => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = "member";
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    let result: Sent;
    try {
      result = await api.post("/api/invitations", {
        email,
        role,
        boards: Object.entries(boards).map(([project, relation]) => ({ project, relation })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invitation could not be sent");
      setSaving(false);
      return;
    }
    setSaving(false);
    setSent(result);
    onInvited();
  }

  return (
    <Modal open={open} onClose={close} closeDisabled={saving} title="Invite someone" size="lg">
      {sent ? (
        <div className="space-y-4">
          {sent.delivery === "email" ? (
            <p role="status" className="text-sm">
              Invitation sent to <span className="font-medium">{sent.invitation.email}</span>. The
              link in it works once and expires in seven days.
            </p>
          ) : (
            <InvitationLink email={sent.invitation.email} link={sent.link} reason={sent.reason} />
          )}
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <div>
            <p className="block text-sm font-medium mb-1">Role</p>
            <div className="flex gap-2" role="group" aria-label="Role">
              <button
                type="button"
                aria-pressed={role === "member"}
                onClick={() => setRole("member")}
                className={`${ROLE_BUTTON} ${role === "member" ? ROLE_ON : ROLE_OFF}`}
              >
                Member
              </button>
              <button
                type="button"
                aria-pressed={role === "admin"}
                onClick={() => setRole("admin")}
                className={`${ROLE_BUTTON} ${role === "admin" ? ROLE_ON : ROLE_OFF}`}
              >
                Admin
              </button>
            </div>
          </div>

          <fieldset>
            <legend className="block text-sm font-medium mb-1">Boards</legend>
            {loadFailed ? (
              <LoadFailed message="The boards could not be loaded." onRetry={reload} busy={retrying} />
            ) : projects.length === 0 ? (
              <p className="text-sm text-text-muted">There is no board yet.</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
                {projects.map((p) => {
                  const relation = boards[p._id];
                  return (
                    <li key={p._id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!relation}
                          onChange={() => toggleBoard(p._id)}
                        />
                        <span className="truncate">
                          {p.name} <span className="text-text-muted">({p.key})</span>
                        </span>
                      </label>
                      {relation && (
                        <div className="w-36 shrink-0">
                          <Select
                            aria-label={`Role on ${p.name}`}
                            value={relation}
                            onChange={(e) =>
                              setBoards((current) => ({
                                ...current,
                                [p._id]: e.target.value as GrantRelation,
                              }))
                            }
                            options={[
                              { value: "member", label: "Member" },
                              { value: "owner", label: "Owner" },
                            ]}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !email.trim()}>
              {saving ? "Sending…" : "Send invitation"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
