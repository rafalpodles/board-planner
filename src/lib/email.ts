import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || "ClaudePlanner <noreply@claudeplanner.app>";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

export function isEmailConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail({ to, subject, text, html }: SendEmailParams): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  try {
    await t.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text,
      html: html || text,
    });
    return true;
  } catch (err) {
    console.error("Failed to send email:", err);
    return false;
  }
}
