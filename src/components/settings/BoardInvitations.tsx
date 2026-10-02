"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard, ListRow } from "@/components/settings/SettingsCard";
import { InvitationLink } from "@/components/settings/InvitationLink";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { ApiBoardInvitation, GrantRelation } from "@/types";

type Sent =
  | { outcome: "created"; delivery: "email" }
  | { outcome: "created"; delivery: "link"; link: string; reason: "no_mail_server" | "mail_failed" }
  | { outcome: "added" }
  | { outcome: "updated" };

export function BoardInvitations({ projectId }: { projectId: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [rows, setRows] = useState<ApiBoardInvitation[]>([]);
  const [read, setRead] = useState<"loading" | "loaded" | "failed">("loading");
  const [email, setEmail] = useState("");
  const [relation, setRelation] = useState<GrantRelation>("member");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<{ email: string; link: string; reason: "no_mail_server" | "mail_failed" } | null>(null);
  const [removing, setRemoving] = useState<ApiBoardInvitation | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");

  const [retrying, setRetrying] = useState(false);
  const latestRead = useRef(0);
  const everLoaded = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++latestRead.current;
    try {
      const loaded: ApiBoardInvitation[] = await api.get(`/api/projects/${projectId}/invitations`);
      if (mine !== latestRead.current) return;
      setRows(loaded);
      setRead("loaded");
      everLoaded.current = true;
    } catch {
      if (mine !== latestRead.current) return;
      // A list already on screen stays there: the write that preceded this read landed
      if (everLoaded.current) toast(LIST_REFRESH_FAILED, "error");
      else setRead("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function retry() {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    const address = email.trim();
    let sent: Sent;
    try {
      sent = await api.post(`/api/projects/${projectId}/invitations`, { email: address, relation });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invitation could not be sent");
      setSending(false);
      return;
    }
    setSending(false);
    setEmail("");
    setLink(null);
    if (sent.outcome === "added") {
      toast(`${address} already had an invitation waiting; this board was added to it`, "success");
    } else if (sent.outcome === "updated") {
      toast(`${address} is already invited to this board. No email sent.`, "success");
    } else if (sent.delivery === "email") {
      toast(`Invitation sent to ${address}`, "success");
    } else {
      setLink({ email: address, link: sent.link, reason: sent.reason });
    }
    await refresh();
  }

  async function remove() {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      await api.del(`/api/projects/${projectId}/invitations/${removing._id}`);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "The invitation could not be withdrawn");
      setRemoveBusy(false);
      await refresh();
      return;
    }
    setRemoveBusy(false);
    toast(`Invitation for ${removing.email} withdrawn from this board`, "success");
    if (link?.email.toLowerCase() === removing.email) setLink(null);
    setRemoving(null);
    await refresh();
  }

  return (
    <SettingsCard
      title="Invite by email"
      description="For somebody without an account. They choose a username and password from the link and land on this board."
    >
      <form onSubmit={handleInvite} className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <Input
            type="email"
            autoComplete="off"
            aria-label="Email to invite"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sending}
          />
        </div>
        <div className="w-32 shrink-0">
          <Select
            aria-label="Role on this board"
            value={relation}
            onChange={(e) => setRelation(e.target.value as GrantRelation)}
            disabled={sending}
            options={[
              { value: "member", label: "Member" },
              { value: "owner", label: "Owner" },
            ]}
          />
        </div>
        <Button type="submit" disabled={sending || !email.trim()}>
          {sending ? "Sending…" : "Invite"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {link && (
        <div className="mt-3" role="status">
          <InvitationLink email={link.email} link={link.link} reason={link.reason} />
        </div>
      )}

      {read === "failed" && (
        <LoadFailed
          className="py-4"
          message="Could not load this board's invitations."
          onRetry={retry}
          busy={retrying}
        />
      )}
      {read === "loaded" && rows.length > 0 && (
        <div className="mt-4 space-y-2" aria-label="Invitations to this board">
          {rows.map((row) => (
            <ListRow key={row._id}>
              <div className="min-w-0 flex-1" data-testid="board-invitation">
                <p className="text-sm font-medium break-all">{row.email}</p>
                <p className="text-xs text-text-muted">
                  {row.relation === "owner" ? "Owner" : "Member"}
                  {row.addedBy ? ` · by ${row.addedBy}` : ""}
                  {" · "}
                  <span className={row.expired ? "text-danger" : undefined}>
                    {row.expired ? "Expired" : `Expires ${new Date(row.expiresAt).toLocaleDateString()}`}
                  </span>
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Withdraw the invitation for ${row.email}`}
                disabled={removeBusy}
                onClick={() => {
                  setRemoveError("");
                  setRemoving(row);
                }}
              >
                Withdraw
              </Button>
            </ListRow>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title="Withdraw invitation"
        message={`${removing?.email ?? ""} will no longer join this board through their invitation.`}
        confirmLabel="Withdraw"
        loadingLabel="Withdrawing…"
        loading={removeBusy}
        error={removeError}
      />
    </SettingsCard>
  );
}
