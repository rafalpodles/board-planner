import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { EmailContent, renderEmail } from "@/lib/email-template";
import { selfOrigin } from "@/lib/session";

/**
 * The mails that say somebody may be taking the account over.
 *
 * None of them consults `emailNotifications`: that switch is about work happening on a board, and
 * a person who turned it off has not agreed to be the last to know their password changed. They
 * are also all fire-and-forget — nobody is waiting on one, and a mail server having a bad
 * afternoon must not take the request down with it.
 */
async function deliver(
  to: string,
  subject: string,
  build: () => EmailContent
): Promise<void> {
  if (!to || !isEmailConfigured()) return;
  // The content is built in here rather than by the caller: every caller starts this with `void`,
  // so anything thrown while assembling it would be an unhandled rejection rather than a log line.
  try {
    const { html, text } = renderEmail(build());
    await sendEmail({ to, subject, text, html });
  } catch (err) {
    console.error(`Could not send the "${subject}" notice:`, err);
  }
}

function signInButton(): { label: string; url: string } | undefined {
  const origin = selfOrigin();
  return origin ? { label: `Sign in to ${APP_NAME}`, url: `${origin}/login` } : undefined;
}

export interface PasswordChangedNotice {
  email: string;
  username: string;
  /** A reset link the account holder followed, or an administrator setting one for them. */
  how: "reset_link" | "admin";
  /** The administrator's username, for the admin case. */
  actor?: string;
  /** Where the reset came from, as the audit row records it. */
  from?: string;
}

export async function notifyPasswordChanged(n: PasswordChangedNotice): Promise<void> {
  const byAdmin = n.how === "admin";
  await deliver(n.email, `The password on your ${APP_NAME} account was changed`, () => ({
    preheader: byAdmin
      ? `An administrator set a new password for ${n.username}.`
      : `The password for ${n.username} was changed with a reset link.`,
    kicker: "Account security",
    heading: `The password for ${n.username} was changed`,
    intro: byAdmin
      ? [
          `An administrator${n.actor ? ` (${n.actor})` : ""} set a new password for this account. The password itself is not sent by email — they will pass it to you directly.`,
          "Every session was signed out, so you will be asked to sign in again.",
        ]
      : [
          "Somebody followed a reset link and set a new password. Every session was signed out, including anyone still signed in on the old password.",
        ],
    alert: byAdmin
      ? undefined
      : {
          tone: "warning",
          lines: [
            "If this wasn't you, whoever did it can sign in as you right now.",
            "Ask an instance administrator to set a password on the account — that is the only step that locks them out.",
          ],
        },
    rows: [
      { label: "Account", value: n.username },
      { label: "Changed", value: new Date().toUTCString() },
      ...(n.from ? [{ label: "Request", value: n.from }] : []),
      ...(byAdmin && n.actor ? [{ label: "Changed by", value: n.actor }] : []),
    ],
    button: signInButton(),
    footer: [
      "Sent because the password on this account changed. This notice cannot be turned off.",
    ],
  }));
}

export interface AddressChangedNotice {
  /** The address losing the account, which is the one that hears about it. */
  previousEmail: string;
  username: string;
  newEmail: string;
  /** The administrator's username, when the account did not do this itself. */
  actor?: string;
}

/** Enough of the new address to recognise it, not enough to hand it to whoever reads the old inbox. */
export function maskAddress(address: string): string {
  const [local, domain] = address.split("@");
  if (!local || !domain) return "•••";
  const tail = domain.split(".").pop();
  return `${local.slice(0, 1)}•••@•••.${tail}`;
}

export async function notifyAddressChanged(n: AddressChangedNotice): Promise<void> {
  await deliver(n.previousEmail, `The email address on your ${APP_NAME} account changed`, () => ({
    preheader: `This address no longer resets the password for ${n.username}.`,
    kicker: "Account security",
    heading: `This address no longer recovers the account ${n.username}`,
    alert: {
      tone: "warning",
      lines: [
        "If this wasn't you, whoever made the change can now request a reset link to their own inbox.",
        "Ask an instance administrator to set a password on the account — that is the only step that locks them out.",
      ],
    },
    rows: [
      { label: "Account", value: n.username },
      { label: "Changed", value: new Date().toUTCString() },
      { label: "Changed by", value: n.actor ?? "the account itself" },
      { label: "New address", value: maskAddress(n.newEmail) },
    ],
    outro: ["If you made this change yourself, there's nothing to do."],
    footer: ["Sent once, to the previous address on the account. This notice cannot be turned off."],
  }));
}

export interface CredentialCreatedNotice {
  email: string;
  username: string;
  kind: "token" | "oauth";
  /** The token's name, or the OAuth client's. */
  name: string;
  /** What it can reach: the boards it is scoped to, or the whole account. */
  scope: string;
}

export async function notifyCredentialCreated(n: CredentialCreatedNotice): Promise<void> {
  const isToken = n.kind === "token";
  const heading = isToken
    ? `A new API token was created on your account`
    : `${n.name} was connected to your account`;
  await deliver(n.email, heading, () => ({
    preheader: `${n.name} can now act as ${n.username}.`,
    kicker: "Account security",
    heading,
    intro: [
      isToken
        ? "It can act as you through the API until it is deleted."
        : "It can act as you through the API until you disconnect it.",
    ],
    rows: [
      { label: isToken ? "Token" : "Application", value: n.name },
      { label: "Reaches", value: n.scope },
      { label: "Created", value: new Date().toUTCString() },
      { label: "Account", value: n.username },
    ],
    outro: ["If you didn't do this, delete it — it works as you until you do."],
    button: tokensButton(),
    footer: [
      "Sent because a credential was created on this account. This notice cannot be turned off.",
    ],
  }));
}

function tokensButton(): { label: string; url: string } | undefined {
  const origin = selfOrigin();
  return origin ? { label: "Review your tokens", url: `${origin}/settings/tokens` } : undefined;
}
