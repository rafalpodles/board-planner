import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/encryption", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
  isEncryptionConfigured: () => true,
}));
vi.mock("@/lib/url-validation", () => ({ isAllowedMcpServerUrl: () => true }));

const { mergeMcpServerTokens, validatePmConfig } = await import("./config");

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

  it("drops the client registration when the URL moves", () => {
    const result = mergeMcpServerTokens([server({ authType: "oauth", ...moved })], oauthStored());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value[0].oauth?.clientId).toBe("");
      expect(result.value[0].oauth?.clientSecret).toBe("");
    }
  });

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

describe("validatePmConfig and the cost controls", () => {
  const base = { enabled: true, model: "m", contextNotes: "", links: [], mcpServers: [] };
  const valid = (over: Record<string, unknown> = {}) =>
    validatePmConfig({ ...base, ...over } as never);

  it("keeps the token ceiling, so the input that sets it is not writing into a void", () => {
    const result = valid({ dailyTokenCap: 500_000 });

    expect(result.valid).toBe(true);
    expect(result.valid && result.value.dailyTokenCap).toBe(500_000);
  });

  it("still keeps the turn cap", () => {
    const result = valid({ dailyTurnCap: 40, dailyTokenCap: 1 });

    expect(result.valid && result.value.dailyTurnCap).toBe(40);
  });

  it("defaults the ceiling to none rather than dropping it", () => {
    const result = valid();

    expect(result.valid && result.value.dailyTokenCap).toBe(0);
  });

  it("refuses a ceiling that could never bind", () => {
    expect(valid({ dailyTokenCap: -1 }).valid).toBe(false);
    expect(valid({ dailyTokenCap: 1.5 }).valid).toBe(false);
    expect(valid({ dailyTokenCap: "lots" }).valid).toBe(false);
  });
});
