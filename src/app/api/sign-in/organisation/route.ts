import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { sha256 } from "@/lib/oauth";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import { claimProof, endSignIn, issueHandoff, releaseProof, scopedToOrganisation, servedOrganisationById } from "@/lib/platform-sign-in";
import { clearedSignInCookie, provenEmail, rememberCookie, signInBinder, signInRoute, startAgain } from "@/lib/platform-sign-in-route";
import { pullNewOrganisationLicence } from "@/lib/licence-pull";
import { NAME_UNAVAILABLE, nameIsTaken } from "@/lib/organisation";
import { SLUG_UNAVAILABLE, checkSignUp, createOrganisation, slugTaken, type SignUpInput } from "@/lib/organisation-sign-up";
import { mailboxOf } from "@/lib/mailbox";
import { PUBLIC_MAIL_DOMAINS } from "@/lib/public-mail-domains";
import { countAttempt, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORGANISATIONS_PER_ADDRESS_PER_DAY = 3;
const ORGANISATIONS_PER_SOURCE_PER_DAY = 10;
// A company domain can mint addresses without end (a catch-all on one host), so the address limit alone is not a
// limit. Counted on organisations created, not on attempts, so nobody can spend a company's share by failing; a
// wildcard of subdomains is a separate bucket each and is not caught
const ORGANISATIONS_PER_COMPANY_DOMAIN_PER_DAY = 8;
const HOUR_MS = 60 * 60 * 1000;
// A taken name tells whoever tried it that an organisation has it; a slug is public on its own host, a name was not
const TAKEN_NAMES_PER_ADDRESS_PER_HOUR = 10;

const refused = (error: string, status = 400) => NextResponse.json({ error }, { status });

export const POST = signInRoute(async (request) => {
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const binder = signInBinder(request);
  const email = await provenEmail(request);
  if (!email) return startAgain();

  const read = await readJsonBody<SignUpInput>(request);
  if (!read.ok) return read.response;
  const checked = checkSignUp(email, read.value);
  if (!checked.ok) return refused(checked.error);
  if (await slugTaken(checked.value.slug)) return refused(SLUG_UNAVAILABLE);
  const takenNames = `organisation-sign-up:names:${sha256(mailboxOf(email).canonical)}`;
  if (await isRateLimited(takenNames, TAKEN_NAMES_PER_ADDRESS_PER_HOUR)) return refused("Too many names tried. Try again in an hour.", 429);
  if (await nameIsTaken(checked.value.name)) {
    await recordFailedAttempt(takenNames, HOUR_MS).catch(() => {});
    return refused(NAME_UNAVAILABLE);
  }

  if (!(await claimProof(binder))) return refused("This sign-in is already creating an organisation.", 409);
  let handedOff = false;
  try {
    const clientIp = getClientIp(request);
    const mailbox = mailboxOf(email);
    // The address and the network count every attempt; the company domain only reads here and counts below, once
    // an organisation exists
    const companyDomainKey =
      mailbox.domain !== "" && !PUBLIC_MAIL_DOMAINS.has(mailbox.domain) ? `organisation-sign-up:domain:${mailbox.domain}` : null;
    const tooMany =
      (await countAttempt(`organisation-sign-up:address:${sha256(mailbox.canonical)}`, DAY_MS)) > ORGANISATIONS_PER_ADDRESS_PER_DAY ||
      (clientIp !== null && (await countAttempt(sourceKey(clientIp, "organisation-sign-up"), DAY_MS)) > ORGANISATIONS_PER_SOURCE_PER_DAY) ||
      (companyDomainKey !== null && (await isRateLimited(companyDomainKey, ORGANISATIONS_PER_COMPANY_DOMAIN_PER_DAY)));
    if (tooMany) return refused("Too many organisations created from this address, network or company today. Try again tomorrow.", 429);

    const created = await createOrganisation(checked.value);
    if (!created.ok) return refused(created.error);
    if (companyDomainKey !== null) await recordFailedAttempt(companyDomainKey, DAY_MS).catch(() => {});

    await pullNewOrganisationLicence(String(created.organisation));

    const organisation = await servedOrganisationById(String(created.organisation));
    if (!organisation) return refused("The organisation was created but has no address yet. Sign in to it in a minute.", 500);
    const code = await issueHandoff(scopedToOrganisation(organisation), created.user);
    await endSignIn(binder);
    handedOff = true;

    const response = NextResponse.json({ location: `${organisation.origin}/api/auth/handoff?code=${encodeURIComponent(code)}` }, { status: 201 });
    response.headers.append("Set-Cookie", rememberCookie(organisation.id));
    response.headers.append("Set-Cookie", clearedSignInCookie());
    return response;
  } finally {
    if (!handedOff) await releaseProof(binder).catch(() => {});
  }
});
