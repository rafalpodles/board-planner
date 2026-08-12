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
});
