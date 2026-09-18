import { expect } from "@playwright/test";
import { SMTP_STUB_CONTROL_URL } from "../playwright.config";

/** One message as `e2e/smtp-stub.mjs` files it. */
export interface StubMessage {
  from: string;
  to: string[];
  data: string;
}

/** What the SMTP stub has received for one address, oldest first */
export async function mailFor(address: string): Promise<StubMessage[]> {
  const response = await fetch(`${SMTP_STUB_CONTROL_URL}/messages`);
  expect(response.ok, "the mail server's control port refused /messages").toBe(true);
  const all: StubMessage[] = await response.json();
  return all.filter((message) => message.to.includes(address));
}

/**
 * A message's body as it was written, with quoted-printable's soft line breaks and `=3D` undone.
 *
 * Anything asserted against the raw `data` is asserted against the encoder: a line over 76
 * characters is folded with a trailing `=`, which can fall inside a task key or a URL.
 *
 * Two cases, not a quoted-printable decoder. `=20` and `=09` — a trailing space or tab, which the
 * encoding also escapes — come back as they were written, which no assertion here reads. A caller
 * matching on trailing whitespace needs a real decoder rather than this.
 */
export function bodyOf(message: StubMessage): string {
  return message.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
}

/** The confirmation link as the message carries it, quoted-printable soft breaks and `=3D` undone */
export function confirmLinkIn(message: StubMessage): string {
  const unfolded = bodyOf(message);
  const match = unfolded.match(/https?:\/\/[^\s"<>]+\/confirm-email#token=[A-Za-z0-9_%-]+/);
  expect(match, "no confirmation link in the message").not.toBeNull();
  return match![0];
}
