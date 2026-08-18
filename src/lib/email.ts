import nodemailer from "nodemailer";
import { APP_NAME, APP_DOMAIN } from "@/lib/brand";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || `${APP_NAME} <noreply@${APP_DOMAIN}>`;

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      // nodemailer's own defaults are two minutes to connect and ten to finish. A blackholed host
      // would hold the test-send request open long past what a person waits, and every fire-and-
      // forget notification would dangle behind it.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // Without this, an attacker who strips the STARTTLS advertisement on port 587 gets the
      // AUTH exchange in cleartext — SMTP_USER and SMTP_PASS handed over (BP-306)
      requireTLS: SMTP_PORT !== 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
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
// The characters that let one person lay claim to another's mailbox are not: `<victim@corp.com>`
// and `victim@corp.com.` both deliver to the victim while being different strings to the unique
// index, so both would pass uniqueness and then send that person somebody else's reset link.
const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  if (/[\s<>,;()[\]\\"]/.test(value)) return false;

  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (value.includes("..")) return false;

  return true;
}

interface SendEmailParams {
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
  to,
  subject,
  text,
  html,
  headers,
}: SendEmailParams): Promise<void> {
  const t = getTransporter();
  if (!t) throw new EmailNotConfiguredError();

  await t.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text,
    html: html || text,
    headers,
  });
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
export function emailSettingsSummary(): {
  configured: boolean;
  host: string;
  port: number;
  user: string;
  from: string;
} {
  return {
    configured: isEmailConfigured(),
    host: SMTP_HOST ?? "",
    port: SMTP_PORT,
    user: SMTP_USER ?? "",
    from: SMTP_FROM,
  };
}
