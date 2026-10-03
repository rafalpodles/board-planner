"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InvitationLink } from "@/components/settings/InvitationLink";
import { ApiInvitation, InvitationDelivery } from "@/types";

type Reissued = { invitation: ApiInvitation; dropped?: string[] } & InvitationDelivery;

function expiryText(invitation: ApiInvitation): string {
  const date = new Date(invitation.expiresAt).toLocaleDateString();
  return invitation.expired ? `Expired ${date}` : `Expires ${date}`;
}

export function PendingInvitations({
  invitations,
  onChanged,
}: {
  invitations: ApiInvitation[];
  onChanged: () => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiInvitation | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const [linkFor, setLinkFor] = useState<Reissued | null>(null);

  async function resend(invitation: ApiInvitation) {
    if (busy) return;
    setBusy(invitation._id);
    try {
      const result: Reissued = await api.post(
        `/api/invitations/${invitation._id}/resend`,
        {},
      );
      if (result.delivery === "email") {
        toast(`Invitation sent again to ${invitation.email}`, "success");
      } else {
        setLinkFor(result);
      }
      if (result.dropped?.length) {
        const one = result.dropped.length === 1;
        toast(
          `Left out ${result.dropped.join(", ")}: whoever added ${one ? "it" : "them"} can no longer grant ${one ? "it" : "them"}.`,
          "info",
        );
      }
      onChanged();
    } catch (err) {
      toast(
        err instanceof Error
          ? err.message
          : "The invitation could not be sent again",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!revoking || busy) return;
    setBusy(revoking._id);
    setRevokeError("");
    try {
      await api.del(`/api/invitations/${revoking._id}`);
    } catch (err) {
      setRevokeError(
        err instanceof Error
          ? err.message
          : "The invitation could not be revoked",
      );
      setBusy(null);
      onChanged();
      return;
    }
    setBusy(null);
    toast(`Invitation for ${revoking.email} revoked`, "success");
    setRevoking(null);
    onChanged();
  }

  return (
    <>
      {invitations.length > 0 && (
        <section className="mt-8" aria-labelledby="pending-invitations">
          <h3 id="pending-invitations" className="text-base font-semibold mb-3">
            Pending invitations
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {invitations.map((invitation) => (
              <li
                key={invitation._id}
                data-testid="pending-invitation"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 basis-full flex-1 sm:basis-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="font-medium break-all">{invitation.email}</p>
                    {invitation.expired ? (
                      <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-danger/15 text-danger">
                        Expired
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                        Invited
                      </span>
                    )}
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                        invitation.role === "admin"
                          ? "bg-primary/20 text-primary"
                          : "bg-bg-input text-text-muted"
                      }`}
                    >
                      {invitation.role === "admin" ? "Admin" : "Member"}
                    </span>
                  </div>
                  <p className="text-sm text-text-muted">
                    {invitation.boards.length
                      ? invitation.boards
                          .map(
                            (b) =>
                              `${b.key}${b.relation === "owner" ? " (owner)" : ""}`,
                          )
                          .join(", ")
                      : "No boards"}
                    {" · "}
                    {invitation.invitedBy
                      ? `by ${invitation.invitedBy.username}`
                      : "by a deleted account"}
                    {" · "}
                    <span
                      className={invitation.expired ? "text-danger" : undefined}
                    >
                      {expiryText(invitation)}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Resend the invitation for ${invitation.email}`}
                    disabled={!!busy}
                    onClick={() => resend(invitation)}
                  >
                    Resend
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Revoke the invitation for ${invitation.email}`}
                    disabled={!!busy}
                    onClick={() => {
                      setRevokeError("");
                      setRevoking(invitation);
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={!!linkFor}
        onClose={() => setLinkFor(null)}
        title="New invitation link"
        size="lg"
      >
        {linkFor && linkFor.delivery === "link" && (
          <div className="space-y-4">
            <InvitationLink
              email={linkFor.invitation.email}
              link={linkFor.link}
              reason={linkFor.reason}
            />
            <p className="text-sm text-text-muted">
              The previous link no longer works.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => setLinkFor(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title="Revoke invitation"
        message={`The link sent to ${revoking?.email ?? ""} will stop working.`}
        confirmLabel="Revoke"
        loadingLabel="Revoking…"
        loading={!!revoking && busy === revoking._id}
        error={revokeError}
      />
    </>
  );
}
