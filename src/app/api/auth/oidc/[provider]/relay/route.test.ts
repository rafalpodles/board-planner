import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const flowExists = vi.fn();
let home: string | null = "https://acme.example";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/session", () => ({ selfOrigin: () => home }));
vi.mock("@/lib/oidc/providers", () => ({
  providerById: (id: string) => (id === "oidc" || id === "github" ? { id } : null),
}));
vi.mock("@/models/oidcFlow", () => ({ OidcFlow: { exists: flowExists } }));

const { GET } = await import("./route");

const relay = (path: string, headers: Record<string, string> = {}) => {
  const provider = path.split("/")[0];
  return GET(new Request(`https://login.example/api/auth/oidc/${path}`, { headers }), {
    params: Promise.resolve({ provider }),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  home = "https://acme.example";
  process.env.OIDC_RELAY_ORIGIN = "https://login.example";
  flowExists.mockResolvedValue({ _id: "f1" });
});

afterEach(() => {
  delete process.env.OIDC_RELAY_ORIGIN;
});

describe("the relay", () => {
  it("forwards a live flow's answer, query untouched, to the callback where the sign-in began", async () => {
    const res = await relay("oidc/relay?code=c1&state=st-1&iss=https%3A%2F%2Fid.example.com");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://acme.example/api/auth/oidc/oidc/callback?code=c1&state=st-1&iss=https%3A%2F%2Fid.example.com"
    );
    expect(flowExists).toHaveBeenCalledWith({
      state: "st-1",
      provider: "oidc",
      claims: null,
      expiresAt: { $gt: expect.any(Date) },
      tenant: DEFAULT_TENANT_ID,
    });
  });

  it("forwards a provider's refusal too, so the callback can send the browser back where it began", async () => {
    const res = await relay("oidc/relay?error=access_denied&state=st-1");

    expect(res.headers.get("location")).toBe("https://acme.example/api/auth/oidc/oidc/callback?error=access_denied&state=st-1");
  });

  it("forwards to the callback of the provider the flow belongs to", async () => {
    const res = await relay("github/relay?code=c1&state=st-1");

    expect(res.headers.get("location")).toBe("https://acme.example/api/auth/oidc/github/callback?code=c1&state=st-1");
    expect(flowExists).toHaveBeenCalledWith(expect.objectContaining({ state: "st-1", provider: "github" }));
  });

  it("takes the destination from configuration, never from the request's host or query", async () => {
    const res = await relay("oidc/relay?code=c1&state=st-1&redirect=https%3A%2F%2Fevil.example", {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
    });

    expect(new URL(res.headers.get("location")!).origin).toBe("https://acme.example");
  });

  it.each([
    ["no state", "oidc/relay?code=c1"],
    ["an empty state", "oidc/relay?code=c1&state="],
    ["a provider that is not configured", "okta/relay?code=c1&state=st-1"],
  ])("answers %s with the expired page, without looking anything up", async (_label, path) => {
    const res = await relay(path);

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("This sign-in has expired");
    expect(flowExists).not.toHaveBeenCalled();
  });

  it("answers a state with no live, unspent flow with the expired page and no redirect", async () => {
    flowExists.mockResolvedValue(null);

    const res = await relay("github/relay?code=c1&state=gone");

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(flowExists).toHaveBeenCalledWith(expect.objectContaining({ state: "gone", provider: "github" }));
  });

  it("does not exist while no relay is configured", async () => {
    delete process.env.OIDC_RELAY_ORIGIN;

    const res = await relay("oidc/relay?code=c1&state=st-1");

    expect(res.status).toBe(404);
    expect(flowExists).not.toHaveBeenCalled();
  });

  it("refuses to guess where to send the browser when this instance has no address", async () => {
    home = null;

    const res = await relay("oidc/relay?code=c1&state=st-1");

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(flowExists).not.toHaveBeenCalled();
  });
});
