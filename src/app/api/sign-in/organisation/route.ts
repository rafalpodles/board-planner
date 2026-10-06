import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { sha256 } from "@/lib/oauth";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import { claimProof, endSignIn, issueHandoff, releaseProof, scopedToOrganisation, servedOrganisationById } from "@/lib/platform-sign-in";
import { clearedSignInCookie, provenEmail, rememberCookie, signInBinder, signInRoute, startAgain } from "@/lib/platform-sign-in-route";
import { pullNewOrganisationLicence } from "@/lib/licence-pull";
import { SLUG_UNAVAILABLE, checkSignUp, createOrganisation, slugTaken } from "@/lib/organisation-sign-up";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORGANISATIONS_PER_ADDRESS_PER_DAY = 3;
const ORGANISATIONS_PER_SOURCE_PER_DAY = 10;

const refused = (error: string, status = 400) => NextResponse.json({ error }, { status });

export const POST = signInRoute(async (request) => {
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const binder = signInBinder(request);
  const email = await provenEmail(request);
  if (!email) return startAgain();

  const read = await readJsonBody<{ name?: unknown; slug?: unknown; username?: unknown; fullName?: unknown; password?: unknown }>(request);
  if (!read.ok) return read.response;
  const checked = checkSignUp(email, read.value);
  if (!checked.ok) return refused(checked.error);
  if (await slugTaken(checked.value.slug)) return refused(SLUG_UNAVAILABLE);

  if (!(await claimProof(binder))) return refused("This sign-in is already creating an organisation.", 409);
  let handedOff = false;
  try {
    const clientIp = getClientIp(request);
    const tooMany =
      (await countAttempt(`organisation-sign-up:address:${sha256(email)}`, DAY_MS)) > ORGANISATIONS_PER_ADDRESS_PER_DAY ||
      (clientIp !== null && (await countAttempt(sourceKey(clientIp, "organisation-sign-up"), DAY_MS)) > ORGANISATIONS_PER_SOURCE_PER_DAY);
    if (tooMany) return refused("Too many organisations created from here today. Try again tomorrow.", 429);

    const created = await createOrganisation(checked.value);
    if (!created.ok) return refused(created.error);

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
