import { describe, it, expect } from "vitest";
import { unexpectedStaticRoutes } from "./static-pages";

describe("the prerendered-page allowlist", () => {
  it("passes the routes every build of this app prerenders", () => {
    expect(unexpectedStaticRoutes({ routes: { "/_global-error": {}, "/icon.svg": {} } })).toEqual([]);
  });

  it("names a page that became static, which would be served without a nonce", () => {
    expect(unexpectedStaticRoutes({ routes: { "/icon.svg": {}, "/login": {}, "/settings/tokens": {} } })).toEqual([
      "/login",
      "/settings/tokens",
    ]);
  });

  it("refuses a manifest it cannot read rather than passing it", () => {
    expect(() => unexpectedStaticRoutes({})).toThrow(/routes/);
    expect(() => unexpectedStaticRoutes(null)).toThrow(/routes/);
  });
});
