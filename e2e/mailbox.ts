import { expect } from "@playwright/test";
import { SMTP_STUB_CONTROL_URL } from "../playwright.config";

/** One message as `e2e/smtp-stub.mjs` files it. */
export interface StubMessage {
  from: string;
  to: string[];
  data: string;
}

/**
 * The stub's control port, checked rather than assumed: it names its paths and 404s anything else,
 * so a helper that stopped matching would read as an empty mailbox — a green "nothing arrived" and
 * a red "nothing was delivered" both for the wrong reason.
 */
async function control(path: string): Promise<Response> {
  const response = await fetch(`${SMTP_STUB_CONTROL_URL}${path}`);
  expect(response.ok, `the mail server's control port refused ${path}`).toBe(true);
  return response;
}

/** What the SMTP stub has received for one address, oldest first */
export async function mailFor(address: string): Promise<StubMessage[]> {
  const all: StubMessage[] = await (await control("/messages")).json();
  return all.filter((message) => message.to.includes(address));
}

/**
 * Makes the server answer 550 at end-of-DATA for one recipient, and record nothing.
 *
 * Aimed at one address rather than at "the next message": the run's other mail is fire-and-forget
 * and can still be in flight when a spec arms this, so an unscoped refusal lands on whichever
 * message arrives first — somebody else's.
 */
export async function refuseMailFor(address: string) {
  const answer = await (await control(`/refuse?to=${encodeURIComponent(address)}`)).json();
  expect(answer.refuseFor, "the mail server did not arm the refusal").toBe(address);
}

export async function stopRefusing() {
  const answer = await (await control("/refuse")).json();
  expect(answer.refuseFor, "the mail server is still refusing somebody's mail").toBeNull();
}

/**
 * A message's body as it was written, with quoted-printable's soft line breaks and `=3D` undone.
 *
 * Anything asserted against the raw `data` is asserted against the encoder: a line over 76
 * characters is folded with a trailing `=`, which can fall inside a task key or a URL.
 *
 * Two cases, not a quoted-printable decoder. `=20` and `=09` — a trailing space or tab, which the
 * encoding also escapes — stay encoded, which no assertion here reads. A caller matching on
 * trailing whitespace needs a real decoder rather than this.
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
