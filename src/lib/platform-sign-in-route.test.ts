import { afterEach, describe, expect, it } from "vitest";
import { forgetCookie, rememberCookie, signInCookie } from "./platform-sign-in-route";

afterEach(() => {
  delete process.env.COOKIE_ALLOW_INSECURE;
});

const attributes = (header: string) => header.split("; ").slice(1);

describe("the remembered organisation cookie (BP-1002)", () => {
  it("lives only as long as the browser session: no Max-Age, no Expires", () => {
    const cookie = rememberCookie("org-1");
    expect(cookie.startsWith("__Host-bp_last_organisation=org-1; ")).toBe(true);
    expect(cookie).not.toMatch(/Max-Age/i);
    expect(cookie).not.toMatch(/Expires/i);
  });

  it("keeps its other attributes", () => {
    expect(attributes(rememberCookie("org-1"))).toEqual(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]);
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(attributes(rememberCookie("org-1"))).toEqual(["Path=/", "HttpOnly", "SameSite=Lax"]);
  });

  it("is still forgotten at once, and the sign-in cookie keeps its lifetime", () => {
    expect(forgetCookie()).toContain("; Max-Age=0;");
    expect(signInCookie("bps_x")).toMatch(/; Max-Age=900;/);
  });
});
