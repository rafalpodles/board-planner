import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const { identity, project, logProjectAudit, findById, findOneAndUpdate } = vi.hoisted(() => ({
  identity: { viaMachineCredential: false },
  project: { version: 0 },
  logProjectAudit: vi.fn(),
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (request: Request, context: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        user: { _id: "u1", ...identity },
        db: { organisation: ORGANISATION, Project: { findById, findOneAndUpdate } },
        params: Promise.resolve({ projectId: String(BOARD) }),
      }),
}));

const ORGANISATION = new Types.ObjectId("0000000000000000000000a1");
const BOARD = new Types.ObjectId("0000000000000000000000c3");
const { GET, POST } = await import("./route");
const { webhookSigningSecret } = await import("@/lib/webhook-signature");

type Handler = (request: Request) => Promise<Response>;
const call = async (handler: unknown) => {
  const response = await (handler as Handler)(new Request("https://x/api"));
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};

beforeEach(() => {
  vi.clearAllMocks();
  identity.viaMachineCredential = false;
  project.version = 0;
  findById.mockImplementation(() => ({ lean: () => Promise.resolve({ _id: BOARD, webhookSigningVersion: project.version }) }));
  findOneAndUpdate.mockImplementation(() => {
    project.version += 1;
    return { lean: () => Promise.resolve({ _id: BOARD, webhookSigningVersion: project.version }) };
  });
  process.env.WEBHOOK_SIGNING_SECRET = "instance-secret";
  process.env.ORGANISATION_DOMAIN = "board-planner.test";
});

afterEach(() => {
  delete process.env.WEBHOOK_SIGNING_SECRET;
  delete process.env.ORGANISATION_DOMAIN;
});

describe("GET /api/projects/[projectId]/webhooks/signing-secret (BP-669)", () => {
  it("serves the project's own key, uncached, and records that it was read", async () => {
    const { status, body, cache } = await call(GET);

    expect(status).toBe(200);
    expect(body).toEqual({ signing: "project", secret: webhookSigningSecret(ORGANISATION, { _id: BOARD }) });
    expect(body.secret).not.toBe("instance-secret");
    expect(cache).toBe("no-store");
    expect(logProjectAudit).toHaveBeenCalledWith(expect.anything(), BOARD, "u1", "webhook_secret_revealed");
  });

  it("never serves the instance's own secret on a single-organisation instance, nor reads the project", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    const { body } = await call(GET);

    expect(body).toEqual({ signing: "instance" });
    expect(findById).not.toHaveBeenCalled();
  });

  it("says deliveries are unsigned when the instance has no secret", async () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;

    expect((await call(GET)).body).toEqual({ signing: "off" });
  });

  it("refuses an API token or a connected app, and records nothing", async () => {
    identity.viaMachineCredential = true;

    expect((await call(GET)).status).toBe(403);
    expect((await call(POST)).status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(logProjectAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/[projectId]/webhooks/signing-secret: rotation", () => {
  it("retires the old key for a new one and records the rotation", async () => {
    const before = (await call(GET)).body.secret;

    const { status, body } = await call(POST);

    expect(status).toBe(200);
    expect(body.secret).not.toBe(before);
    expect(body.secret).toBe(webhookSigningSecret(ORGANISATION, { _id: BOARD, webhookSigningVersion: 1 }));
    expect(findOneAndUpdate).toHaveBeenCalledWith({ _id: String(BOARD) }, { $inc: { webhookSigningVersion: 1 } }, expect.anything());
    expect(logProjectAudit).toHaveBeenLastCalledWith(expect.anything(), BOARD, "u1", "webhook_secret_rotated", "version 1");
  });

  it("is refused on a single-organisation instance, whose one secret is the operator's", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await call(POST)).status).toBe(409);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
