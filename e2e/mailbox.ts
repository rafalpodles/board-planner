import { expect } from "@playwright/test";
import { SMTP_STUB_CONTROL_URL } from "../playwright.config";

export interface StubMessage {
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

/** The confirmation link as the message carries it, quoted-printable soft breaks and `=3D` undone */
export function confirmLinkIn(message: StubMessage): string {
  const unfolded = message.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const match = unfolded.match(/https?:\/\/[^\s"<>]+\/confirm-email#token=[A-Za-z0-9_%-]+/);
  expect(match, "no confirmation link in the message").not.toBeNull();
  return match![0];
}
