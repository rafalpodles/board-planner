import nodemailer, { type Transporter } from "nodemailer";
import type { Types } from "mongoose";
import { APP_NAME, APP_DOMAIN } from "@/lib/brand";
import { organisationDomain } from "./organisation-host";
import { ownMailFrom, ownMailServerFor, ownMailTransport } from "./organisation-smtp";
import { smtpTransportOptions } from "./smtp-transport";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || `${APP_NAME} <noreply@${APP_DOMAIN}>`;

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport(smtpTransportOptions({ host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS }));
  }
  return transporter;
}

export function isEmailConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

// Deliberately not RFC 5322: an address is proven by a message arriving at it, and a stricter
// pattern only turns real addresses away. Two things it does have to do, though.
//
// A single-label domain is allowed — `admin@intranet` is an ordinary address on the company
// network this product is self-hosted on, and demanding a dot locks those deployments out of
// their own email entirely.
//
// The characters that let one person lay claim to another's mailbox are not: `<victim@corp.com>`,
// `victim@corp.com.` and `x:victim@corp.com` (nodemailer reads `x:` as a group name) all deliver
// to the victim while being different strings to the unique index, so each would pass uniqueness
// and then send that person somebody else's reset link. Only printable ASCII is accepted, because
// nodemailer strips control characters such as U+0085 on the way out.
const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  if (/[<>,;:()[\]\\"]/.test(value)) return false;

  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (value.includes("..")) return false;

  return true;
}

// Mail to an organisation's people goes through its own server when it has one (BP-899); the platform's own mail never does
export type MailSender = Types.ObjectId | "platform";

interface SendEmailParams {
  sender: MailSender;
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("No mail server is configured");
  }
}

/**
 * Throws whatever the mail server said. The only caller that wants this is the one a person is
 * watching — everywhere else a delivery failure must not take the request down with it.
 */
export async function sendEmailOrThrow({
  sender,
  to,
  subject,
  text,
  html,
  headers,
}: SendEmailParams): Promise<void> {
  const message = { to, subject, text, html: html || text, headers };

  // A refusal by the organisation's own server is that server's answer, never a reason to send through ours instead
  const own = sender === "platform" ? null : await ownMailServerFor(sender);
  if (own) {
    await (await ownMailTransport(own)).sendMail({ ...message, from: ownMailFrom(own) });
    return;
  }

  const t = getTransporter();
  if (!t) throw new EmailNotConfiguredError();
  await t.sendMail({ ...message, from: SMTP_FROM });
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  try {
    await sendEmailOrThrow(params);
    return true;
  } catch (err) {
    console.error("Failed to send email:", err);
    return false;
  }
}

/** What an instance admin may see about the mail server. Never the password. */
export type EmailSettingsSummary =
  | { managedByPlatform: false; configured: boolean; host: string; port: number; user: string; from: string }
  // On a shared instance the mail server is the platform's, so an organisation sees only that it works
  | { managedByPlatform: true; configured: boolean; from: string };

export function emailSettingsSummary(): EmailSettingsSummary {
  if (organisationDomain()) return { managedByPlatform: true, configured: isEmailConfigured(), from: SMTP_FROM };
  return {
    managedByPlatform: false,
    configured: isEmailConfigured(),
    host: SMTP_HOST ?? "",
    port: SMTP_PORT,
    user: SMTP_USER ?? "",
    from: SMTP_FROM,
  };
}
