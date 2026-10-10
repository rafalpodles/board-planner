import { afterEach, describe, expect, it } from "vitest";
import { rememberCookie, rememberedOrganisationIn, signInCookie } from "./platform-sign-in-route";

afterEach(() => {
  delete process.env.COOKIE_ALLOW_INSECURE;
});

const attributes = (header: string) => header.split("; ").slice(1);

describe("the remembered organisation cookie (BP-1009)", () => {
  it("outlives the browser session: 180 days, set as Max-Age", () => {
    const cookie = rememberCookie("org-1");
    expect(cookie.startsWith("__Host-bp_last_organisation=org-1; ")).toBe(true);
    expect(cookie).toContain(`; Max-Age=${180 * 24 * 60 * 60};`);
  });

  it("keeps its other attributes", () => {
    expect(attributes(rememberCookie("org-1")).filter((attribute) => !attribute.startsWith("Max-Age"))).toEqual(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]);
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(attributes(rememberCookie("org-1")).filter((attribute) => !attribute.startsWith("Max-Age"))).toEqual(["Path=/", "HttpOnly", "SameSite=Lax"]);
  });

  it("is read back from a request's cookie header, and only under the name this deployment sets", () => {
    expect(rememberedOrganisationIn("a=1; __Host-bp_last_organisation=org-1; b=2")).toBe("org-1");
    expect(rememberedOrganisationIn("bp_last_organisation=org-2")).toBeNull();
    expect(rememberedOrganisationIn(null)).toBeNull();
    process.env.COOKIE_ALLOW_INSECURE = "1";
    expect(rememberedOrganisationIn("bp_last_organisation=org-2")).toBe("org-2");
  });

  it("leaves the sign-in cookie its own lifetime", () => {
    expect(signInCookie("bps_x")).toMatch(/; Max-Age=900;/);
  });
});
