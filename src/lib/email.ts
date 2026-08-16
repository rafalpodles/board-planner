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

// Deliberately not RFC 5322: the address is proven by a message arriving at it, and a stricter
// pattern only turns valid addresses away. This catches the typo that has no @ or no domain.
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
}: SendEmailParams): Promise<void> {
  const t = getTransporter();
  if (!t) throw new EmailNotConfiguredError();

  await t.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text,
    html: html || text,
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
