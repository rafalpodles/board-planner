import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { sha256 } from "@/lib/oauth";
import { passwordSignInEnabled, passwordSignInOff } from "@/lib/password-sign-in";
import { endSignIn, issueHandoff, scopedToOrganisation, servedOrganisationById } from "@/lib/platform-sign-in";
import { clearedSignInCookie, provenEmail, rememberCookie, signInBinder, signInRoute, startAgain } from "@/lib/platform-sign-in-route";
import { createOrganisation } from "@/lib/organisation-sign-up";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORGANISATIONS_PER_ADDRESS_PER_DAY = 3;
const ORGANISATIONS_PER_SOURCE_PER_DAY = 10;

const tooMany = () => NextResponse.json({ error: "Too many organisations created from here today. Try again tomorrow." }, { status: 429 });

export const POST = signInRoute(async (request) => {
  if (!passwordSignInEnabled()) return passwordSignInOff();
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const email = await provenEmail(request);
  if (!email) return startAgain();

  const read = await readJsonBody<{ name?: unknown; slug?: unknown; username?: unknown; fullName?: unknown; password?: unknown }>(request);
  if (!read.ok) return read.response;

  const clientIp = getClientIp(request);
  const perAddress = `organisation-sign-up:address:${sha256(email)}`;
  const perSource = clientIp ? sourceKey(clientIp, "organisation-sign-up") : null;
  if (await isRateLimited(perAddress, ORGANISATIONS_PER_ADDRESS_PER_DAY)) return tooMany();
  if (perSource && (await isRateLimited(perSource, ORGANISATIONS_PER_SOURCE_PER_DAY))) return tooMany();

  const created = await createOrganisation(email, read.value);
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });
  await recordFailedAttempt(perAddress, DAY_MS);
  if (perSource) await recordFailedAttempt(perSource, DAY_MS);

  const organisation = await servedOrganisationById(String(created.organisation));
  if (!organisation) return NextResponse.json({ error: "The organisation was created but has no address yet. Try signing in." }, { status: 500 });
  const code = await issueHandoff(scopedToOrganisation(organisation), created.user);
  await endSignIn(signInBinder(request));

  const response = NextResponse.json({ location: `${organisation.origin}/api/auth/handoff?code=${encodeURIComponent(code)}` }, { status: 201 });
  response.headers.append("Set-Cookie", rememberCookie(organisation.id));
  response.headers.append("Set-Cookie", clearedSignInCookie());
  return response;
});
