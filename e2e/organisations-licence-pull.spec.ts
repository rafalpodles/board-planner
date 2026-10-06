import { test, expect, type APIRequestContext } from "@playwright/test";
import { createPublicKey, verify } from "node:crypto";
import http from "node:http";
import { LICENCE_STUB_PORT, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { PLATFORM_HEADERS, platformSigningString } from "../src/lib/platform-request";
import { E2E_LICENCE_PULL_KEY, e2eLicence } from "./licence-key";
import { ACME, GLOBEX, ORGANISATIONS_API, asOrganisation, bearer, seedTwoOrganisations, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");
test.describe.configure({ mode: "serial" });

interface Asked {
  organisation: string;
  signed: boolean;
}

const keys = new Map<string, string>();
const asked: Asked[] = [];
let answerWith = 200;
let stub: http.Server;

const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: E2E_LICENCE_PULL_KEY.x }, format: "jwk" });

function signedByBoardPlanner(request: http.IncomingMessage, body: Buffer): boolean {
  const header = (name: string) => String(request.headers[name] ?? "");
  if (header(PLATFORM_HEADERS.keyId) !== E2E_LICENCE_PULL_KEY.keyId) return false;
  const signing = platformSigningString(request.method!, header("host"), request.url!, header(PLATFORM_HEADERS.timestamp), header(PLATFORM_HEADERS.nonce), body);
  return verify(null, Buffer.from(signing), publicKey, Buffer.from(header(PLATFORM_HEADERS.signature), "base64url"));
}

test.beforeAll(async () => {
  stub = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const signed = signedByBoardPlanner(request, body);
      const organisation = String(JSON.parse(body.toString() || "{}").organisation ?? "");
      asked.push({ organisation, signed });
      if (!signed) return void response.writeHead(401).end();
      if (answerWith !== 200) return void response.writeHead(answerWith).end();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ licenceKey: keys.get(organisation) ?? null }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(LICENCE_STUB_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test.beforeEach(async () => {
  await seedTwoOrganisations();
  keys.clear();
  asked.length = 0;
  answerWith = 200;
});

const pull = (request: APIRequestContext) => request.post(`${ORGANISATIONS_API}/api/e2e/licence-pull`, { headers: { "sec-fetch-site": "same-origin" } });

async function planOf(request: APIRequestContext, who: OrganisationFixture): Promise<string> {
  return (await (await request.get(`${ORGANISATIONS_API}/api/entitlements`, { headers: { ...asOrganisation(who), ...bearer(who) } })).json()).plan;
}

const keyFor = (who: OrganisationFixture, issuedAt = new Date().toISOString()) =>
  e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString(), issuedAt });

// BP-897: a key the licence service holds reaches its organisation without anybody touching the database
test.describe("BP-897: each organisation pulls its licence from the licence service", () => {
  test("every served organisation asks, signed with Board Planner's key, and the one with a key turns Pro", async ({ request }) => {
    keys.set(ACME.organisation.toHexString(), keyFor(ACME));

    expect((await pull(request)).status()).toBe(204);

    const ids = asked.map((entry) => entry.organisation);
    expect(ids).toEqual(expect.arrayContaining([ACME.organisation.toHexString(), GLOBEX.organisation.toHexString()]));
    expect(asked.every((entry) => entry.signed)).toBe(true);
    expect([await planOf(request, ACME), await planOf(request, GLOBEX)]).toEqual(["pro", "free"]);
  });

  test("a key bound to another organisation, or older than the one stored, changes nothing", async ({ request }) => {
    keys.set(ACME.organisation.toHexString(), keyFor(GLOBEX));
    await pull(request);
    expect(await planOf(request, ACME)).toBe("free");

    keys.set(ACME.organisation.toHexString(), keyFor(ACME));
    await pull(request);
    expect(await planOf(request, ACME)).toBe("pro");

    keys.set(ACME.organisation.toHexString(), e2eLicence({ customer: "older", plan: "free", organisation: ACME.organisation.toHexString(), issuedAt: "2020-01-01T00:00:00.000Z" }));
    await pull(request);
    expect(await planOf(request, ACME)).toBe("pro");
  });

  test("a licence service that is down or refuses leaves every plan as it was", async ({ request }) => {
    keys.set(ACME.organisation.toHexString(), keyFor(ACME));
    await pull(request);
    expect(await planOf(request, ACME)).toBe("pro");

    for (const status of [500, 401]) {
      answerWith = status;
      expect((await pull(request)).status()).toBe(204);
      expect(await planOf(request, ACME)).toBe("pro");
    }
  });
});
