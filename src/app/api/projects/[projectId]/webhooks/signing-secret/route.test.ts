import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const { identity } = vi.hoisted(() => ({ identity: { viaMachineCredential: false } }));

vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (request: Request, context: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, { user: { _id: "u1", ...identity }, db: { organisation: ORGANISATION }, params: Promise.resolve({}) }),
}));

const ORGANISATION = new Types.ObjectId("0000000000000000000000a1");
const { GET } = await import("./route");
const { webhookSigningSecret } = await import("@/lib/webhook-signature");

const get = async () => {
  const response = await (GET as unknown as (request: Request) => Promise<Response>)(new Request("https://x/api"));
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};

beforeEach(() => {
  identity.viaMachineCredential = false;
  process.env.WEBHOOK_SIGNING_SECRET = "instance-secret";
  delete process.env.ORGANISATION_DOMAIN;
});

afterEach(() => {
  delete process.env.WEBHOOK_SIGNING_SECRET;
  delete process.env.ORGANISATION_DOMAIN;
});

describe("GET /api/projects/[projectId]/webhooks/signing-secret (BP-669)", () => {
  it("serves the organisation's own key with organisations on subdomains, uncached", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";

    const { status, body, cache } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({ signing: "organisation", secret: webhookSigningSecret(ORGANISATION) });
    expect(body.secret).not.toBe("instance-secret");
    expect(cache).toBe("no-store");
  });

  it("never serves the instance's own secret on a single-organisation instance", async () => {
    const { body } = await get();

    expect(body).toEqual({ signing: "instance" });
    expect(JSON.stringify(body)).not.toContain("instance-secret");
  });

  it("says deliveries are unsigned when the instance has no secret", async () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;
    process.env.ORGANISATION_DOMAIN = "board-planner.test";

    expect((await get()).body).toEqual({ signing: "off" });
  });

  it("refuses an API token or a connected app, which cannot be the person reading it", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    identity.viaMachineCredential = true;

    const { status, body } = await get();

    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
  });
});
