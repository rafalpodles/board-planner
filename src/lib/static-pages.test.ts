import { describe, it, expect } from "vitest";
import { unexpectedStaticRoutes } from "./static-pages";

describe("the prerendered-page allowlist", () => {
  it("passes the routes every build of this app prerenders", () => {
    expect(unexpectedStaticRoutes({ routes: { "/_global-error": {}, "/icon.svg": {} }, dynamicRoutes: {} })).toEqual([]);
  });

  it("names a page that became static, which would be served without a nonce", () => {
    expect(unexpectedStaticRoutes({ routes: { "/icon.svg": {}, "/login": {}, "/settings/tokens": {} }, dynamicRoutes: {} })).toEqual([
      "/login",
      "/settings/tokens",
    ]);
  });

  it("names a route prerendered from generateStaticParams or ISR, which is static too", () => {
    expect(
      unexpectedStaticRoutes({ routes: { "/icon.svg": {} }, dynamicRoutes: { "/projects/[projectId]": {} } })
    ).toEqual(["/projects/[projectId]"]);
  });

  it("refuses a manifest it cannot read rather than passing it", () => {
    expect(() => unexpectedStaticRoutes({})).toThrow(/routes/);
    expect(() => unexpectedStaticRoutes({ routes: {} })).toThrow(/dynamicRoutes/);
    expect(() => unexpectedStaticRoutes(null)).toThrow(/routes/);
  });
});
