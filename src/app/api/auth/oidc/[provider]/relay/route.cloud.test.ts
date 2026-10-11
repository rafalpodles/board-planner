import { describe, it, expect, vi, beforeEach } from "vitest";

let cloud = true;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
// The environment names no generic provider: an organisation's own is stored in its settings (BP-951)
vi.mock("@/lib/oidc/providers", () => ({ providerById: (id: string) => (id === "github" ? { id } : null) }));
vi.mock("@/lib/oidc/relay", () => ({ relayOrigin: () => "https://login.example", relayedHome: async () => "https://acme.example" }));
vi.mock("@/lib/organisation-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
  organisationDomain: () => (cloud ? "board.example" : null),
}));

const { GET } = await import("./route");

const relay = (provider: string) =>
  GET(new Request(`https://login.example/api/auth/oidc/${provider}/relay?code=c1&state=st-1`), { params: Promise.resolve({ provider }) });

beforeEach(() => {
  cloud = true;
});

describe("the relay in the cloud (BP-951)", () => {
  it("forwards a sign-in through an organisation's own provider, which the environment does not name", async () => {
    const res = await relay("oidc");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://acme.example/api/auth/oidc/oidc/callback?code=c1&state=st-1");
  });

  it("knows no other provider the environment does not name", async () => {
    expect((await relay("google")).status).toBe(400);
    expect((await relay("evil")).status).toBe(400);
  });

  it("still knows no generic provider where one organisation is the instance and the environment names none", async () => {
    cloud = false;

    expect((await relay("oidc")).status).toBe(400);
  });
});
