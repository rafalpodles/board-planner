import { describe, it, expect } from "vitest";
import { catalogKey } from "./catalog-key";

const row = (patch: Partial<Parameters<typeof catalogKey>[0]> = {}) => ({
  name: "notion",
  url: "https://mcp.notion.com/mcp",
  authType: "bearer",
  authToken: "",
  hasAuthToken: false,
  ...patch,
});

/**
 * This key is what a server's discovered tool catalogue is stored under. Anything in it that
 * changes when nothing about the connection changed makes the catalogue, the success line and that
 * server's whole contribution to the flood warning vanish — which is what putting the token's
 * value in it did, at the moment Save was pressed (BP-569 review 5).
 */
describe("catalogKey survives a save", () => {
  it("is unchanged when a typed token becomes a stored one", () => {
    const beforeSave = catalogKey(row({ authToken: "cpat_secret", hasAuthToken: false }));
    // `pmDraftFrom` blanks authToken on every commit and sets hasAuthToken from the response
    const afterSave = catalogKey(row({ authToken: "", hasAuthToken: true }));

    expect(afterSave).toBe(beforeSave);
  });

  it("never contains the token itself", () => {
    expect(catalogKey(row({ authToken: "cpat_secret" }))).not.toContain("cpat_secret");
  });

  it("is unchanged by an OAuth connection being established", () => {
    const before = catalogKey({ ...row({ authType: "oauth" }), oauthStatus: undefined } as never);
    const after = catalogKey({ ...row({ authType: "oauth" }), oauthStatus: "connected" } as never);

    expect(after).toBe(before);
  });
});

/** The control: the four things that DO mean a different catalogue each change it. */
describe("catalogKey changes when the connection does", () => {
  it("distinguishes a different host, name, auth type and the arrival of a token", () => {
    const base = catalogKey(row());

    expect(catalogKey(row({ url: "https://elsewhere.example/mcp" }))).not.toBe(base);
    expect(catalogKey(row({ name: "other" }))).not.toBe(base);
    expect(catalogKey(row({ authType: "none" }))).not.toBe(base);
    expect(catalogKey(row({ authToken: "cpat_secret" }))).not.toBe(base);
  });

  it("ignores whitespace a half-typed field carries", () => {
    expect(catalogKey(row({ name: " notion " }))).toBe(catalogKey(row()));
  });
});
