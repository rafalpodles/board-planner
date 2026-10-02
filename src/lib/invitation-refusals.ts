import { InvitationRefusal } from "@/lib/invitations";

export const INVITATION_REFUSALS: Record<InvitationRefusal, string> = {
  unknown: "This invitation link is not valid. Ask whoever invited you for a new one.",
  expired: "This invitation has expired. Ask whoever invited you for a new one.",
  used: "This invitation has already been used. Sign in instead.",
  revoked: "This invitation was withdrawn. Ask whoever invited you for a new one.",
};
