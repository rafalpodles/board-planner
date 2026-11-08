import { isValidEmail, normaliseEmail } from "@/lib/email";

export interface SmtpInput {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

const HOST = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function parseSmtpInput(body: unknown): { ok: true; value: SmtpInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the mail server's settings as JSON" };
  const input = body as Record<string, unknown>;

  const host = text(input.host).toLowerCase();
  if (!host || host.length > 253 || !HOST.test(host)) return { ok: false, error: "Enter the mail server's host name, such as smtp.example.com, with no scheme or port" };

  const port = typeof input.port === "number" ? input.port : Number(text(input.port));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Enter a port between 1 and 65535, usually 587 or 465" };

  const user = text(input.user);
  if (!user || user.length > 254 || CONTROL.test(user)) return { ok: false, error: "Enter the username the mail server signs in with" };

  const password = typeof input.password === "string" ? input.password : "";
  if (password.length > 1000 || CONTROL.test(password)) return { ok: false, error: "That password cannot be used" };

  const fromAddress = normaliseEmail(text(input.fromAddress));
  if (!isValidEmail(fromAddress)) return { ok: false, error: "Enter the address mail is sent from" };

  const fromName = text(input.fromName);
  if (fromName.length > 80 || CONTROL.test(fromName)) return { ok: false, error: "The sender name is at most 80 characters on one line" };

  return { ok: true, value: { host, port, user, password, fromAddress, fromName } };
}
