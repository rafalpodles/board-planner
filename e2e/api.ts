import { expect, type APIRequestContext } from "@playwright/test";
import { API_TOKEN, MEMBER_API_TOKEN } from "./seed";

// Playwright's APIRequestContext sends neither Origin nor Sec-Fetch-Site, and the provenance
// check is fail-closed: a state-changing request carrying neither is refused with 403.
export const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

export const ADMIN_AUTH = { ...SAME_ORIGIN, Authorization: `Bearer ${API_TOKEN}` };
export const MEMBER_AUTH = { ...SAME_ORIGIN, Authorization: `Bearer ${MEMBER_API_TOKEN}` };

/**
 * Logs the request context in, leaving its cookie jar holding a browser session. Only for
 * assertions a Bearer credential would answer differently: the endpoints gated on
 * viaMachineCredential refuse a token before they ever look at the caller's role, so a test
 * naming a role would pass on a 403 that says nothing about one.
 */
export async function signInApi(
  request: APIRequestContext,
  username: string,
  password: string
): Promise<void> {
  const response = await request.post("/api/auth/login", {
    headers: SAME_ORIGIN,
    data: { username, password },
  });
  expect(response.status(), await response.text()).toBe(200);
}
