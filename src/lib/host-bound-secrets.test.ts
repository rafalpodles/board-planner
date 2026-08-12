import { describe, it, expect } from "vitest";
import { tokensInvalidatedByHostChange, sameOrigin } from "./host-bound-secrets";

const stored = {
  gitlabHost: "https://gitlab.example.com",
  gitlabToken: "enc:v2:abc:stored",
  codaHost: "https://coda.io",
  codaToken: "enc:v2:abc:coda",
};

function labels(updates: Record<string, unknown>, before = stored) {
  return tokensInvalidatedByHostChange(updates, before).map((p) => p.label);
}

// BP-315: the token is unreadable through the API, but the host it is sent to was an ordinary
// editable field — so repointing the host and triggering a sync delivered the cleartext
// credential to an address of the caller's choosing.
describe("tokensInvalidatedByHostChange", () => {
  it("invalidates the token when its host moves", () => {
    expect(labels({ gitlabHost: "https://collector.attacker.example" })).toEqual(["GitLab"]);
  });

  it("invalidates each token independently", () => {
    expect(
      labels({
        gitlabHost: "https://collector.attacker.example",
        codaHost: "https://collector.attacker.example",
      })
    ).toEqual(["GitLab", "Coda"]);
  });

  it("keeps the token when a new one is supplied in the same request", () => {
    expect(
      labels({ gitlabHost: "https://gitlab.other.com", gitlabToken: "glpat-fresh" })
    ).toEqual([]);
  });

  it("keeps the token when the host is unchanged", () => {
    expect(labels({ gitlabHost: "https://gitlab.example.com" })).toEqual([]);
  });

  // Cosmetic differences are not a move, or every ordinary save would clear the token
  it.each([
    "https://gitlab.example.com/",
    "https://GitLab.Example.com",
    "https://gitlab.example.com:443",
  ])("treats %s as the same host", (host) => {
    expect(labels({ gitlabHost: host })).toEqual([]);
  });

  it("treats a path change on the same origin as the same host", () => {
    expect(labels({ gitlabHost: "https://gitlab.example.com/subpath" })).toEqual([]);
  });

  it("does nothing when the host is not part of the update at all", () => {
    expect(labels({ name: "renamed" })).toEqual([]);
  });

  it("has nothing to invalidate when no token is stored", () => {
    expect(
      labels({ gitlabHost: "https://elsewhere.example" }, { ...stored, gitlabToken: "" })
    ).toEqual([]);
  });

  it("invalidates when the host is cleared back to the default", () => {
    expect(labels({ gitlabHost: "" })).toEqual(["GitLab"]);
  });

  it("does not treat an empty new token as a replacement", () => {
    expect(labels({ gitlabHost: "https://elsewhere.example", gitlabToken: "" })).toEqual([
      "GitLab",
    ]);
  });
});

describe("sameOrigin", () => {
  it("compares by origin", () => {
    expect(sameOrigin("https://a.example/x", "https://a.example/y")).toBe(true);
    expect(sameOrigin("https://a.example", "http://a.example")).toBe(false);
    expect(sameOrigin("https://a.example", "https://b.example")).toBe(false);
  });

  // Two values that cannot be parsed are only the same host if they are the same string —
  // returning true for both would make every unparseable host look unchanged
  it("compares unparseable values as opaque strings", () => {
    expect(sameOrigin("not a url", "not a url")).toBe(true);
    expect(sameOrigin("not a url", "also not a url")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(sameOrigin(undefined, "https://a.example")).toBe(false);
    expect(sameOrigin("https://a.example", undefined)).toBe(false);
    expect(sameOrigin("", "")).toBe(false);
  });
});
