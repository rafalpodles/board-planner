import { passwordSignInEnabled } from "@/lib/password-sign-in";
import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { InvitationBoardInput } from "@/lib/invitations";
import { InvitationDelivery, IUser } from "@/types";

export const NO_ORIGIN_ERROR =
  "This instance does not know its own address (PUBLIC_ORIGIN), so it cannot build a link. Ask an administrator.";
export const INTERACTIVE_ONLY = "This action requires an interactive session";

export function invitationLink(origin: string, token: string): string {
  return `${origin}/invite?token=${encodeURIComponent(token)}`;
}

export interface InvitationMail {
  to: string;
  token: string;
  origin: string;
  inviterName: string;
  role: "admin" | "member";
  boards: { name: string; relation: "owner" | "member" }[];
}

export async function deliverInvitation(mail: InvitationMail): Promise<InvitationDelivery> {
  const link = invitationLink(mail.origin, mail.token);
  if (!isEmailConfigured()) return { delivery: "link", link, reason: "no_mail_server" };

  const { html, text } = renderEmail({
    preheader: "The link works once and expires in seven days.",
    kicker: "Invitation",
    heading: `${mail.inviterName} invited you to ${APP_NAME}`,
    intro: [
      mail.role === "admin"
        ? `You are invited as an administrator of ${mail.origin}.`
        : `You are invited to ${mail.origin}.`,
      passwordSignInEnabled()
        ? "Choose a username and a password to finish setting up your account."
        : "Sign in with your provider and choose a username to finish setting up your account.",
    ],
    rows: mail.boards.map((b) => ({
      label: b.name,
      value: b.relation === "owner" ? "owner" : "member",
    })),
    proseRows: true,
    button: { label: "Accept the invitation", url: link },
    showButtonUrl: true,
    outro: ["The link works once and expires seven days after it was sent."],
    footer: [
      `Sent because ${mail.inviterName} invited ${mail.to}.`,
      "If you did not expect it, ignore this message and nothing will happen.",
    ],
  });
  const sent = await sendEmail({
    to: mail.to,
    subject: `${mail.inviterName} invited you to ${APP_NAME}`,
    text,
    html,
  });
  return sent ? { delivery: "email" } : { delivery: "link", link, reason: "mail_failed" };
}

export function deliverTo(
  to: string,
  token: string,
  origin: string,
  inviter: Pick<IUser, "username" | "fullName">,
  role: "admin" | "member",
  boards: InvitationBoardInput[],
  projects: { _id: unknown; name: string }[]
): Promise<InvitationDelivery> {
  const nameOf = new Map(projects.map((p) => [String(p._id), p.name]));
  return deliverInvitation({
    to,
    token,
    origin,
    inviterName: inviter.fullName || inviter.username,
    role,
    boards: boards.map((b) => ({
      name: nameOf.get(String(b.project)) ?? "a board",
      relation: b.relation,
    })),
  });
}
