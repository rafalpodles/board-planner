import { test, expect, type APIRequestContext } from "@playwright/test";
import { RUN_TENANTS_SERVER, TENANTS_PORT } from "../playwright.config";
import { ACME, GLOBEX, PLATFORM_HOST, TENANTS_API, asTenant, bearer, originOf, seedTwoTenants, type TenantFixture } from "./tenants";
import { MCP_HEADERS } from "./mcp";
import { bodyOf, mailFor } from "./mailbox";

test.skip(!RUN_TENANTS_SERVER, "needs the TENANT_DOMAIN server — set E2E_TENANTS_SERVER=1");

test.beforeEach(async () => {
  await seedTwoTenants();
});

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function upload(request: APIRequestContext, who: TenantFixture) {
  const res = await request.post(`${TENANTS_API}/api/uploads`, {
    headers: { ...asTenant(who), cookie: `__Host-bp_session=${who.sessionToken}`, origin: originOf(who) },
    multipart: { file: { name: "plan.png", mimeType: "image/png", buffer: TINY_PNG }, projectId: String(who.projectId) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { url: string };
}

// BP-670: every address the app publishes or sends belongs to the organisation it is about
test.describe("BP-670: each organisation's own addresses, documents and files", () => {
  test("the OAuth discovery documents name each organisation's own host, and none for a host with no organisation", async ({ request }) => {
    for (const who of [ACME, GLOBEX]) {
      const res = await request.get(`${TENANTS_API}/.well-known/oauth-authorization-server`, { headers: asTenant(who) });
      expect(res.status(), who.slug).toBe(200);
      const doc = await res.json();
      expect(doc.issuer, who.slug).toBe(originOf(who));
      expect(doc.token_endpoint, who.slug).toBe(`${originOf(who)}/oauth/token`);
    }
    const nobody = await request.get(`${TENANTS_API}/.well-known/oauth-authorization-server`, {
      headers: { host: `nobody.tenants.localhost:${TENANTS_PORT}` },
    });
    expect(nobody.status()).toBe(404);
  });

  test("MCP answers an organisation's credential on its own host, and refuses it on the other's", async ({ request }) => {
    const list = (who: TenantFixture, host: TenantFixture) =>
      request.post(`${TENANTS_API}/api/mcp`, {
        headers: { ...asTenant(host), ...bearer(who), ...MCP_HEADERS },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });

    expect((await list(ACME, ACME)).status()).toBe(200);
    expect((await list(ACME, GLOBEX)).status()).toBe(401);
    const platform = await request.post(`${TENANTS_API}/api/mcp`, {
      headers: { host: PLATFORM_HOST, ...bearer(ACME), ...MCP_HEADERS },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(platform.status()).toBe(404);
  });

  test("a password reset mailed from one organisation links back to that organisation's host", async ({ request }) => {
    const address = `boss@${GLOBEX.slug}.example`;
    const res = await request.post(`${TENANTS_API}/api/auth/forgot`, {
      headers: { ...asTenant(GLOBEX), origin: originOf(GLOBEX), "content-type": "application/json" },
      data: { identifier: address },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);

    await expect.poll(async () => (await mailFor(address)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const body = bodyOf((await mailFor(address)).at(-1)!);
    expect(body).toContain(`${originOf(GLOBEX)}/reset`);
    expect(body).not.toContain(originOf(ACME));
  });

  test("a password reset asked for on one organisation's host mails nobody in the other", async ({ request }) => {
    const acmeAddress = `boss@${ACME.slug}.example`;
    const before = (await mailFor(acmeAddress)).length;

    await request.post(`${TENANTS_API}/api/auth/forgot`, {
      headers: { ...asTenant(GLOBEX), origin: originOf(GLOBEX), "content-type": "application/json" },
      data: { identifier: acmeAddress },
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await mailFor(acmeAddress)).length).toBe(before);
  });

  test("a file uploaded in one organisation cannot be fetched from the other", async ({ request }) => {
    const { url } = await upload(request, ACME);
    const path = new URL(url, originOf(ACME)).pathname;

    const own = await request.get(`${TENANTS_API}${path}`, { headers: { ...asTenant(ACME), ...bearer(ACME) } });
    expect(own.status()).toBe(200);

    const other = await request.get(`${TENANTS_API}${path}`, { headers: { ...asTenant(GLOBEX), ...bearer(GLOBEX) } });
    expect([403, 404]).toContain(other.status());
  });
});
