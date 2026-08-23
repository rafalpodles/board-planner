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

/**
 * The connection is resolved once from the stored state and the request. Every one of these was a
 * defect: a request that changed nothing reported the connection gone and wiped chat everywhere, an
 * address was storable under no service, and a `chat` that was not an object deleted the credential.
 */
describe("the truth table for the chat connection", () => {
  const connected = { chat: { kind: "slack", webhookUrl: "enc:x" }, projects: [] };

  it("re-stating the connection exactly as it stands changes nothing about it", async () => {
    stored({ ...connected, projects: [{ project: "p1", matrix: grid(true) }] });

    await put({ chat: { kind: "slack" } });

    const set = written();
    expect(set["notifications.chat.kind"]).toBe("slack");
    expect(set).not.toHaveProperty("notifications.chat.webhookUrl");
    // and above all: the columns it never asked to touch are still standing
    expect(set).not.toHaveProperty("notifications.defaults");
    expect(set).not.toHaveProperty("notifications.projects.0.matrix");
  });

  it("refuses an address with no service rather than storing one nothing reads", async () => {
    stored({ chat: { kind: "", webhookUrl: "" }, projects: [] });

    const res = await put({ chat: { webhookUrl: "https://hooks.example/x" } });

    expect(res.status).toBe(400);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it.each([["a string", "slack"], ["a number", 5], ["an array", []]])(
    "refuses a chat that is %s instead of reading it as a disconnect",
    async (_label, value) => {
      stored(connected);

      const res = await put({ chat: value });

      expect(res.status).toBe(400);
      expect(findByIdAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("keeps the stored address when the sentinel is sent for the same service", async () => {
    stored(connected);

    await put({ chat: { kind: "slack", webhookUrl: "__kept__" } });

    expect(written()).not.toHaveProperty("notifications.chat.webhookUrl");
  });

  it("clears the address when the service is cleared", async () => {
    stored(connected);

    await put({ chat: { kind: "" } });

    expect(written()["notifications.chat.webhookUrl"]).toBe("");
  });
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

  // The grid itself is an ordinary preference — only the standing channel is withheld
  it("lets a machine credential change the grid", async () => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put({ defaults: grid(false) });

    expect(res.status).toBe(200);
    expect(written()).toHaveProperty("notifications.defaults");
  });

  // The hole the first version of this gate left: it watched for `chat` in the body, so a token
  // could leave the address alone and simply switch the column on against one the owner had
  // already stored — the standing outbound copy, reached without mentioning chat at all.
  it("refuses to switch chat on against an address the owner already stored", async () => {
    caller = { _id: "u1", viaMachineCredential: true };
    stored({
      defaults: grid(false),
      chat: { kind: "slack", webhookUrl: "enc:x" },
      projects: [],
    });

    const res = await put({ defaults: grid(true) });

    expect(res.status).toBe(403);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Tearing the channel down is not the risk the rule is about
  it("lets a machine credential disconnect", async () => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put({ chat: { kind: "" } });

    expect(res.status).toBe(200);
    expect(written()["notifications.chat.webhookUrl"]).toBe("");
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

    // Row by row rather than the whole array: a wholesale $set regenerates every subdocument id
    // and reverts a row another tab added between the read and the write
    const set = written();
    expect(set).not.toHaveProperty("notifications.projects");
    const row = set["notifications.projects.0.matrix"] as Record<string, { chat: boolean }>;
    expect(row.mentioned.chat).toBe(false);
  });
});
