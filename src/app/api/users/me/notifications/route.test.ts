import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findByIdAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({
  User: {
    findById: (...a: unknown[]) => findById(...a),
    findByIdAndUpdate: (...a: unknown[]) => findByIdAndUpdate(...a),
  },
}));
let caller: { _id: string; viaMachineCredential?: boolean } = { _id: "u1" };
vi.mock("@/lib/middleware", () => ({
  withAuth:
    (handler: (req: Request, ctx: { user: typeof caller }) => unknown) => (req: Request) =>
      handler(req, { user: caller }),
}));
vi.mock("@/lib/encryption", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  isEncryptionConfigured: () => true,
}));
vi.mock("@/lib/url-validation", () => ({ isAllowedWebhookUrl: (u: string) => u.startsWith("https://") }));

const { PUT } = await import("@/app/api/users/me/notifications/route");
const { NOTIFICATION_TYPES } = await import("@/types");

const grid = (chat: boolean) =>
  Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, { inApp: true, email: true, chat }]));

function stored(notifications: unknown) {
  findById.mockReturnValue({ lean: async () => ({ _id: "u1", notifications }) });
}

// withAuth is mocked to a one-argument handler; the real signature takes the context too
const put = (body: unknown) =>
  (PUT as unknown as (req: Request) => Promise<Response>)(
    new Request("http://x/api/users/me/notifications", { method: "PUT", body: JSON.stringify(body) })
  );

const written = () => findByIdAndUpdate.mock.calls.at(-1)?.[1].$set as Record<string, unknown>;

beforeEach(() => {
  findById.mockReset();
  findByIdAndUpdate.mockReset();
  findByIdAndUpdate.mockResolvedValue({});
  caller = { _id: "u1" };
  stored({ chat: { kind: "slack", webhookUrl: "enc:x" }, projects: [] });
});

describe("who may point a webhook at themselves", () => {
  // The same argument PUT /api/users/me makes about the address: a webhook is a standing outbound
  // copy of everything this person is told, chosen once and never shown back, so a token able to
  // install one is a token that becomes a listening post.
  it("refuses a machine credential, and writes nothing", async () => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put({ chat: { kind: "slack", webhookUrl: "https://hooks.example/x" } });

    expect(res.status).toBe(403);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  // The grid itself is an ordinary preference — only the webhook is the standing channel
  it("lets a machine credential change the grid", async () => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put({ defaults: grid(false) });

    expect(res.status).toBe(200);
    expect(written()).toHaveProperty("notifications.defaults");
  });
});

describe("what a PUT is allowed to clear", () => {
  // normaliseMatrix(undefined) is an all-off grid, so writing it unconditionally meant a client
  // sending only a chat connection silently went dark on every row and every channel
  it("leaves the grid alone when the request carries none", async () => {
    await put({ chat: { kind: "slack", webhookUrl: "https://hooks.example/x" } });

    expect(written()).not.toHaveProperty("notifications.defaults");
  });

  // A client that serialises a missing field as null must not be read as "mute everything"
  it("treats a null grid as absent rather than as all-off", async () => {
    await put({ defaults: null, chat: { kind: "slack", webhookUrl: "https://hooks.example/x" } });

    expect(written()).not.toHaveProperty("notifications.defaults");
  });

  it("refuses a request that carries nothing at all", async () => {
    expect((await put({})).status).toBe(400);
  });
});

describe("chat cannot be ticked against a connection that does not exist", () => {
  // Delivery needs a service AND an address. Checking only the service let one request name a
  // kind, store no webhook, and have the column accepted against it — so the state itself is
  // refused rather than tidied afterwards.
  it("refuses to name a service without an address, so the half-connected state cannot exist", async () => {
    stored({ chat: { kind: "", webhookUrl: "" }, projects: [] });

    const res = await put({ defaults: grid(true), chat: { kind: "slack" } });

    expect(res.status).toBe(400);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  // And with no connection at all in play, a grid asking for chat is stripped rather than stored
  it("strips chat from a grid sent by an account with no connection", async () => {
    stored({ chat: { kind: "", webhookUrl: "" }, projects: [] });

    await put({ defaults: grid(true) });

    const set = written();
    expect((set["notifications.defaults"] as Record<string, { chat: boolean }>).mentioned.chat).toBe(false);
  });

  it("refuses a new service that brings no address of its own", async () => {
    const res = await put({ chat: { kind: "discord" } });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/its own webhook address/i);
  });
});

describe("disconnecting", () => {
  // Refusing the save left people unable to save at all, with the chat column disabled and still
  // ticked — the control that would have fixed it taken away by the same screen
  it("clears chat from the grid rather than refusing the request", async () => {
    await put({ defaults: grid(true), chat: { kind: "" } });

    const set = written();
    expect((set["notifications.defaults"] as Record<string, { chat: boolean }>).mentioned.chat).toBe(false);
    expect(set["notifications.chat.webhookUrl"]).toBe("");
  });

  it("clears chat from every project override too, not only the global grid", async () => {
    stored({
      chat: { kind: "slack", webhookUrl: "enc:x" },
      projects: [{ project: "p1", matrix: grid(true) }],
    });

    await put({ chat: { kind: "" } });

    const rows = written()["notifications.projects"] as { matrix: Record<string, { chat: boolean }> }[];
    expect(rows[0].matrix.mentioned.chat).toBe(false);
  });
});
