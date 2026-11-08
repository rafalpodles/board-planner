import type { SMTPTransportOptions } from "nodemailer/lib/smtp-transport";

export interface SmtpConnection {
  host: string;
  port: number;
  user: string;
  pass: string;
  // The name the certificate must carry when `host` is the address the name was resolved to
  servername?: string;
}

export function smtpTransportOptions({ host, port, user, pass, servername }: SmtpConnection): SMTPTransportOptions {
  return {
    host,
    port,
    secure: port === 465,
    // nodemailer's own defaults are two minutes to connect and ten to finish. A blackholed host
    // would hold the test-send request open long past what a person waits, and every fire-and-
    // forget notification would dangle behind it.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // Without this, an attacker who strips the STARTTLS advertisement on port 587 gets the
    // AUTH exchange in cleartext — the username and password handed over (BP-306)
    requireTLS: port !== 465,
    ...(servername ? { servername } : {}),
    auth: { user, pass },
  };
}

// A server refusing AUTH sometimes quotes the offending command back, and that command carries the
// password. One line, capped, keeps the diagnosis without the credential.
export function mailServerAnswer(err: unknown): string {
  const message = err instanceof Error ? err.message : "The mail server refused the message";
  return message.split("\n")[0].slice(0, 200);
}
