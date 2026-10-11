import { describe, it, expect, vi } from "vitest";

const safeFetch = vi.fn();
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/safe-fetch")>()), safeFetch }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { guardedFetch } = await import("./flow");

describe("what a provider an organisation named may answer with (BP-951)", () => {
  it("is read up to a bound and no further, so one provider cannot make the process hold a body of its choosing", async () => {
    safeFetch.mockResolvedValue(new Response("x".repeat(2_000_000), { status: 200, headers: { "content-type": "application/json" } }));

    const response = await guardedFetch("https://login.acme.example/.well-known/openid-configuration", {} as never);

    expect((await response.text()).length).toBe(256 * 1024);
    expect(safeFetch).toHaveBeenCalledWith("https://login.acme.example/.well-known/openid-configuration", {}, { allowLoopback: expect.any(Boolean) });
  });

  it("hands on a status that has no body, which a Response cannot be given one for", async () => {
    safeFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await guardedFetch("https://login.acme.example/jwks", {} as never);

    expect(response.status).toBe(204);
  });

  it("hands on the status, so a refusal is still a refusal", async () => {
    safeFetch.mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 401, headers: { "content-type": "application/json" } }));

    const response = await guardedFetch("https://login.acme.example/token", { method: "POST" } as never);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client" });
  });
});
