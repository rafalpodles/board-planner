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
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
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
