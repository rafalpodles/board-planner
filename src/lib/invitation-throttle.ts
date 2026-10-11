import { NextResponse } from "next/server";
import type { ScopedDb } from "@/lib/db-scope";
import { isRateLimited, recordFailedAttempt } from "@/lib/rate-limit";
import { invitationLink } from "@/lib/invitation-mail";
import type { InvitationDelivery } from "@/types";

export const INVITES_PER_ORGANISATION = 100;
export const INVITES_PER_ADDRESS = 5;
// Across every organisation, so the address's inbox keeps a ceiling however many organisations there are
export const INVITES_PER_ADDRESS_EVERYWHERE = 20;

const organisationKey = (db: ScopedDb) => `invite-send:${db.organisation.toHexString()}`;
const addressKey = (db: ScopedDb, email: string) => `board-invite-to:${db.organisation.toHexString()}:${email}`;
const inboxKey = (email: string) => `board-invite-to:${email}`;

export const tooManyInvitations = () =>
  NextResponse.json({ error: "Too many invitations. Try again in 15 minutes." }, { status: 429 });

/** Refusals that name only this organisation's own doing, never another's. */
export async function invitationRefusal(db: ScopedDb, email: string): Promise<NextResponse | null> {
  if (await isRateLimited(organisationKey(db), INVITES_PER_ORGANISATION)) return tooManyInvitations();
  if (await isRateLimited(addressKey(db, email), INVITES_PER_ADDRESS)) {
    return NextResponse.json(
      { error: "That address has been invited too often. Try again in 15 minutes." },
      { status: 429 }
    );
  }
  return null;
}

/**
 * Sends the invitation, unless the address's inbox is past its ceiling across organisations, in which
 * case the inviter gets the link to pass on themselves, which is what they get when the mail fails.
 * A refusal here would tell them somebody else is inviting that address.
 */
export async function deliverWithinBudget(
  db: ScopedDb,
  email: string,
  origin: string,
  token: string,
  send: () => Promise<InvitationDelivery>
): Promise<InvitationDelivery> {
  const mail = !(await isRateLimited(inboxKey(email), INVITES_PER_ADDRESS_EVERYWHERE));
  await recordFailedAttempt(organisationKey(db));
  await recordFailedAttempt(addressKey(db, email));
  if (!mail) return { delivery: "link", link: invitationLink(origin, token), reason: "mail_failed" };
  await recordFailedAttempt(inboxKey(email));
  return send();
}
