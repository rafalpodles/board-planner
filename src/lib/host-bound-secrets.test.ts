import { describe, it, expect } from "vitest";
import {
  tokensInvalidatedByHostChange,
  sameOrigin,
  sameEndpoint,
  clearsStoredToken,
} from "./host-bound-secrets";

const stored = {
  gitlabHost: "https://gitlab.example.com",
  gitlabToken: "enc:v2:abc:stored",
  codaHost: "https://coda.io",
  codaToken: "enc:v2:abc:coda",
};

function labels(updates: Record<string, unknown>, before = stored) {
  return tokensInvalidatedByHostChange(updates, before).map((p) => p.label);
}

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

  it.each([
    "https://gitlab.example.com/",
    "https://GitLab.Example.com",
    "https://gitlab.example.com:443",
  ])("treats %s as the same host", (host) => {
    expect(labels({ gitlabHost: host })).toEqual([]);
  });

  it("treats a path change on the same origin as a move", () => {
    expect(labels({ gitlabHost: "https://gitlab.example.com/subpath" })).toEqual(["GitLab"]);
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

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])("treats a %s stored host as the default rather than as a move", (_case, storedHost) => {
    const before = { ...stored, gitlabHost: storedHost as string };
    expect(labels({ gitlabHost: "https://gitlab.com" }, before)).toEqual([]);
  });

  it("still invalidates when a defaulted stored host is repointed elsewhere", () => {
    const before = { ...stored, gitlabHost: undefined as unknown as string };
    expect(labels({ gitlabHost: "https://collector.attacker.example" }, before)).toEqual([
      "GitLab",
    ]);
  });

  it("treats a Coda save that only edits the doc id as no move at all", () => {
    const before = { ...stored, codaHost: undefined as unknown as string };
    expect(labels({ codaHost: "https://coda.io", codaDocId: "d2" }, before)).toEqual([]);
  });
});

describe("clearsStoredToken", () => {
  const GL = "https://gitlab.com";

  it("says yes for a genuine move with no replacement token", () => {
    expect(clearsStoredToken("https://gitlab.acme.com", GL, "", GL)).toBe(true);
  });

  it.each(["https://gitlab.com/", "https://GitLab.com", " https://gitlab.com "])(
    "stays quiet for the cosmetic edit %o",
    (typed) => {
      expect(clearsStoredToken(typed, GL, "", GL)).toBe(false);
    }
  );

  it("stays quiet when the field is cleared back to the default", () => {
    expect(clearsStoredToken("", GL, "", GL)).toBe(false);
  });

  it("stays quiet when a replacement token comes with the move", () => {
    expect(clearsStoredToken("https://gitlab.acme.com", GL, "glpat-fresh", GL)).toBe(false);
  });

  it("does not count whitespace as a replacement token", () => {
    expect(clearsStoredToken("https://gitlab.acme.com", GL, "   ", GL)).toBe(true);
  });

  it("counts a path change, like the rule it mirrors", () => {
    expect(
      clearsStoredToken("https://intra.example.com/apps", "https://intra.example.com/gitlab", "", GL)
    ).toBe(true);
  });
});

describe("sameEndpoint", () => {
  it("distinguishes paths on the same origin", () => {
    expect(sameEndpoint("https://a.example/mcp", "https://a.example/other")).toBe(false);
    expect(sameEndpoint("https://a.example/mcp", "https://a.example/mcp")).toBe(true);
  });

  it("ignores a trailing slash and a case difference in the host", () => {
    expect(sameEndpoint("https://a.example/mcp/", "https://a.example/mcp")).toBe(true);
    expect(sameEndpoint("https://A.Example/mcp", "https://a.example/mcp")).toBe(true);
  });

  it("keeps the query, which selects the resource on some servers", () => {
    expect(sameEndpoint("https://a.example/mcp?v=1", "https://a.example/mcp?v=2")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(sameEndpoint(undefined, "https://a.example/mcp")).toBe(false);
    expect(sameEndpoint("", "")).toBe(false);
  });
});

describe("sameOrigin", () => {
  it("compares by origin", () => {
    expect(sameOrigin("https://a.example/x", "https://a.example/y")).toBe(true);
    expect(sameOrigin("https://a.example", "http://a.example")).toBe(false);
    expect(sameOrigin("https://a.example", "https://b.example")).toBe(false);
  });

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
