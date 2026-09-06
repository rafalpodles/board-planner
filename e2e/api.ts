import { expect, type APIRequestContext } from "@playwright/test";
import { API_TOKEN, MEMBER_API_TOKEN } from "./seed";

export const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

export const ADMIN_AUTH = { ...SAME_ORIGIN, Authorization: `Bearer ${API_TOKEN}` };
export const MEMBER_AUTH = { ...SAME_ORIGIN, Authorization: `Bearer ${MEMBER_API_TOKEN}` };

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
