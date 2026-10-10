import { NextResponse } from "next/server";
import { isDatabaseUnreachable } from "./db-errors";
import { databaseUnavailable, hostNotFound } from "./middleware";
import { organisationOfRequest } from "./organisation-host";
import { buildFlowCookie, readFlowCookie } from "./session";
import { REMEMBERED_ORGANISATION_COOKIE, SIGN_IN_COOKIE, VERIFIED_TTL_MS, verifiedEmail } from "./platform-sign-in";

export async function refusedOffThePlatform(request: Request): Promise<NextResponse | null> {
  return (await organisationOfRequest(request)).kind === "platform" ? null : hostNotFound();
}

export const signInBinder = (request: Request) => readFlowCookie(request, SIGN_IN_COOKIE);

export const signInCookie = (binder: string) => buildFlowCookie(SIGN_IN_COOKIE, binder, Math.floor(VERIFIED_TTL_MS / 1000));

export const clearedSignInCookie = () => buildFlowCookie(SIGN_IN_COOKIE, "", 0);

export const rememberedOrganisation = (request: Request) => readFlowCookie(request, REMEMBERED_ORGANISATION_COOKIE);

export const rememberCookie = (organisation: string) => buildFlowCookie(REMEMBERED_ORGANISATION_COOKIE, organisation, null);

export const forgetCookie = () => buildFlowCookie(REMEMBERED_ORGANISATION_COOKIE, "", 0);

export async function provenEmail(request: Request): Promise<string | null> {
  return verifiedEmail(signInBinder(request));
}

export const startAgain = () =>
  NextResponse.json({ error: "This sign-in has expired. Enter your e-mail address again.", restart: true }, { status: 401 });

export function signInRoute(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const offPlatform = await refusedOffThePlatform(request);
      if (offPlatform) return offPlatform;
      return await handler(request);
    } catch (error) {
      if (isDatabaseUnreachable(error)) return databaseUnavailable();
      throw error;
    }
  };
}
