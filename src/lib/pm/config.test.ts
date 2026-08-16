import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/encryption", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
  isEncryptionConfigured: () => true,
}));
vi.mock("@/lib/url-validation", () => ({ isAllowedMcpServerUrl: () => true }));

const { mergeMcpServerTokens } = await import("./config");

function server(overrides: Record<string, unknown> = {}) {
  return {
    name: "notion",
    url: "https://mcp.notion.com/mcp",
    authType: "bearer",
    authToken: "",
    allowWrites: false,
    toolAllowlist: [],
    enabled: true,
    ...overrides,
  } as never;
}

function stored(overrides: Record<string, unknown> = {}) {
  return [server({ authToken: "enc:stored-secret", ...overrides })];
}

// BP-315: a bearer token is issued for one server. mergeMcpServerTokens matched saved servers to
// incoming ones by name alone and carried the stored token forward with no comparison of the URL,
// so an admin who could not read the token could point the connection at their own server and
// have it delivered. The OAuth branch beside it already dropped its tokens on a URL change.
describe("mergeMcpServerTokens and a moved URL", () => {
  it("carries the stored token forward while the URL is unchanged", () => {
    const result = mergeMcpServerTokens([server()], stored());

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].authToken).toBe("enc:stored-secret");
  });

  it("refuses to carry a bearer token to a different URL", () => {
    const result = mergeMcpServerTokens(
      [server({ url: "https://collector.attacker.example/mcp" })],
      stored()
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/re-entering its token/);
  });

  it("accepts a moved URL when a new token comes with it", () => {
    const result = mergeMcpServerTokens(
      [server({ url: "https://collector.attacker.example/mcp", authToken: "fresh" })],
      stored()
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].authToken).toBe("enc:fresh");
  });

  // A path change is a different resource on the same server, so the token does not follow it
  it("treats a path change as a move", () => {
    const result = mergeMcpServerTokens(
      [server({ url: "https://mcp.notion.com/other" })],
      stored()
    );

    expect(result.valid).toBe(false);
  });

  it("leaves a server with no auth alone", () => {
    const result = mergeMcpServerTokens(
      [server({ authType: "none", url: "https://elsewhere.example/mcp" })],
      stored({ authType: "none" })
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].authToken).toBe("");
  });

  // The rule the integration hosts already follow: a retyped trailing slash is not a new server,
  // and a 400 here is paid for by re-entering a token the admin may not hold
  it.each([
    "https://mcp.notion.com/mcp/",
    "https://MCP.Notion.com/mcp",
  ])("carries the token across the cosmetic difference in %s", (url) => {
    const result = mergeMcpServerTokens([server({ url })], stored());

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].authToken).toBe("enc:stored-secret");
  });
});

function oauthStored(overrides: Record<string, unknown> = {}) {
  return [
    server({
      authType: "oauth",
      authToken: "",
      oauth: {
        clientId: "client-1",
        clientSecret: "enc:client-secret",
        accessToken: "enc:access",
        refreshToken: "enc:refresh",
        authorizationEndpoint: "https://mcp.notion.com/authorize",
        tokenEndpoint: "https://mcp.notion.com/token",
        status: "connected",
      },
      ...overrides,
    }),
  ];
}

// The bearer fix above left the OAuth half open two ways, both found by the BP-315 review.
describe("mergeMcpServerTokens and moved OAuth credentials", () => {
  const moved = { url: "https://collector.attacker.example/mcp" };

  it("drops the access and refresh tokens when the URL moves", () => {
    const result = mergeMcpServerTokens([server({ authType: "oauth", ...moved })], oauthStored());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value[0].oauth?.accessToken).toBe("");
      expect(result.value[0].oauth?.refreshToken).toBe("");
    }
  });

  // A client registered with the old provider is not a credential for the new one. Keeping it made
  // the next Connect skip re-registration and send the secret to the new server's token endpoint.
  it("drops the client registration when the URL moves", () => {
    const result = mergeMcpServerTokens([server({ authType: "oauth", ...moved })], oauthStored());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value[0].oauth?.clientId).toBe("");
      expect(result.value[0].oauth?.clientSecret).toBe("");
    }
  });

  // The reset used to sit inside `if (authType === "oauth")`, so one save could park a live token
  // against the new URL and the next could flip auth back with the URLs already equal
  it("does not smuggle a live token to a new URL by way of another authType", () => {
    const first = mergeMcpServerTokens(
      [server({ authType: "none", ...moved })],
      oauthStored()
    );

    expect(first.valid).toBe(true);
    if (!first.valid) return;
    expect(first.value[0].oauth?.accessToken ?? "").toBe("");

    const second = mergeMcpServerTokens(
      [server({ authType: "oauth", ...moved })],
      first.value
    );

    expect(second.valid).toBe(true);
    if (second.valid) expect(second.value[0].oauth?.accessToken ?? "").toBe("");
  });

  // sanitizeMcpServers returns oauthClientId (it is not a secret) and the settings page posts it
  // back on every save, which put the old registration straight back after the reset dropped it
  it("does not let the settings page put the dropped client id back", () => {
    const result = mergeMcpServerTokens(
      [server({ authType: "oauth", ...moved, oauthClientId: "client-1" })],
      oauthStored()
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].oauth?.clientId).toBe("");
  });

  it("still takes a client id the admin actually typed for the new server", () => {
    const result = mergeMcpServerTokens(
      [server({ authType: "oauth", ...moved, oauthClientId: "client-2" })],
      oauthStored()
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value[0].oauth?.clientId).toBe("client-2");
  });

  it("keeps the whole OAuth connection while the URL is unchanged", () => {
    const result = mergeMcpServerTokens([server({ authType: "oauth" })], oauthStored());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value[0].oauth?.accessToken).toBe("enc:access");
      expect(result.value[0].oauth?.clientId).toBe("client-1");
      expect(result.value[0].oauth?.status).toBe("connected");
    }
  });
});
