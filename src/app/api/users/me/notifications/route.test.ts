import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
const findOneAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({
  User: {
    findOne: (...a: unknown[]) => findOne(...a),
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
  },
}));
let caller: { _id: string; viaMachineCredential?: boolean } = { _id: "u1" };
vi.mock("@/lib/middleware", () => ({
  withAuth:
    (handler: (req: Request, ctx: { user: typeof caller; db: unknown }) => unknown) => (req: Request) =>
      handler(req, { user: caller, db: scopedToDefaultTenant() }),
}));
vi.mock("@/lib/encryption", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  isEncryptionConfigured: () => true,
}));
let mailServer = true;
vi.mock("@/lib/email", () => ({ isEmailConfigured: () => mailServer }));
const DESTINATION = { allowLoopback: "the webhook destination" };
const isAllowed = vi.fn((u: string, _o?: unknown) => u.startsWith("https://"));
vi.mock("@/lib/url-validation", () => ({
  WEBHOOK_DESTINATION: DESTINATION,
  WEBHOOK_DESTINATION_REFUSED: "refused",
  isAllowedWebhookUrl: (u: string, o: unknown) => isAllowed(u, o),
}));

const { GET, PUT } = await import("@/app/api/users/me/notifications/route");
const { NOTIFICATION_TYPES } = await import("@/types");
const { scopedToDefaultTenant } = await import("@/lib/db-scope");

const grid = (chat: boolean) =>
  Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, { inApp: true, email: true, chat }]));

function stored(notifications: unknown) {
  findOne.mockReturnValue({ lean: async () => ({ _id: "u1", notifications }) });
}

// withAuth is mocked to a one-argument handler; the real signature takes the context too
const put = (body: unknown) =>
  (PUT as unknown as (req: Request) => Promise<Response>)(
    new Request("http://x/api/users/me/notifications", { method: "PUT", body: JSON.stringify(body) })
  );

const written = () => findOneAndUpdate.mock.calls.at(-1)?.[1].$set as Record<string, unknown>;

const CONNECTED = { chat: { kind: "slack", webhookUrl: "enc:x" }, projects: [] };

beforeEach(() => {
  findOne.mockReset();
  findOneAndUpdate.mockReset();
  findOneAndUpdate.mockResolvedValue({});
  caller = { _id: "u1" };
  stored(CONNECTED);
  mailServer = true;
});

// BP-735. The screen closes the e-mail column when nothing can be sent there, and only the server
// knows whether a mail server is configured.
describe("what the screen is told about mail", () => {
  const get = async () =>
    (await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://x/api/users/me/notifications")
    )).json();
  const account = (email: string) =>
    findOne.mockReturnValue({ lean: async () => ({ _id: "u1", email, notifications: CONNECTED }) });

  it("says whether the instance has a mail server and the account an address", async () => {
    account("someone@example.com");
    expect((await get()).email).toEqual({ server: true, address: true });

    mailServer = false;
    account("");
    expect((await get()).email).toEqual({ server: false, address: false });
  });

  it("reads the address it reports on", async () => {
    account("someone@example.com");
    await get();
    expect(findOne.mock.calls.at(-1)?.[1]).toMatch(/\bemail\b/);
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

/**
 * The connection is resolved once from the stored state and the request, and it writes two fields
 * and nothing else. Each of these was a defect: re-stating the connection reported it gone and
 * wiped the chat column everywhere, an address was storable under no service, and a `chat` that
 * said nothing — `{}` or a non-object — deleted an unrecoverable credential on a 200.
 */
describe("the truth table for the chat connection", () => {
  it("re-stating the connection exactly as it stands leaves the credential alone", async () => {
    await put({ chat: { kind: "slack" } });

    const set = written();
    expect(set["notifications.chat.kind"]).toBe("slack");
    expect(set).not.toHaveProperty("notifications.chat.webhookUrl");
  });

  it("keeps the stored address when the sentinel is sent for the same service", async () => {
    await put({ chat: { kind: "slack", webhookUrl: "__kept__" } });

    expect(written()).not.toHaveProperty("notifications.chat.webhookUrl");
  });

  it("refuses a new service that brings no address of its own", async () => {
    const res = await put({ chat: { kind: "discord" } });

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses an address with no service rather than storing one nothing reads", async () => {
    const res = await put({ chat: { webhookUrl: "https://hooks.example/x" } });

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["a string", "slack"],
    ["a number", 5],
    ["an array", []],
  ])("refuses a chat that is %s instead of reading it as a disconnect", async (_l, value) => {
    const res = await put({ chat: value });

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // The trap one shape over from the one above: an object that names nothing is a partial update,
  // not an instruction to destroy a credential
  it("leaves the connection alone when chat is an object that says nothing", async () => {
    const res = await put({ defaults: grid(false), chat: {} });

    expect(res.status).toBe(200);
    const set = written();
    expect(set).not.toHaveProperty("notifications.chat.kind");
    expect(set).not.toHaveProperty("notifications.chat.webhookUrl");
  });

  it("clears the address when the service is cleared", async () => {
    await put({ chat: { kind: "" } });

    const set = written();
    expect(set["notifications.chat.kind"]).toBe("");
    expect(set["notifications.chat.webhookUrl"]).toBe("");
  });

  // Disconnecting used to rewrite the grid and every project override to strip chat, which cost a
  // race, regenerated subdocument ids, and left the screen disabling the box it demanded you clear
  it("touches no grid at all when the connection goes away", async () => {
    stored({ ...CONNECTED, projects: [{ project: "p1", matrix: grid(true) }] });

    await put({ chat: { kind: "" } });

    const set = written();
    expect(set).not.toHaveProperty("notifications.defaults");
    expect(set).not.toHaveProperty("notifications.projects");
    expect(set).not.toHaveProperty("notifications.projects.0.matrix");
  });

  // A tick with no connection is a preference, not an error: it delivers nothing today and starts
  // working if a webhook appears, which resolveChannels decides at send time
  it("stores a chat tick from an account with no connection", async () => {
    stored({ chat: { kind: "", webhookUrl: "" }, projects: [] });

    const res = await put({ defaults: grid(true) });

    expect(res.status).toBe(200);
    const rows = written()["notifications.defaults"] as Record<string, { chat: boolean }>;
    expect(rows.mentioned.chat).toBe(true);
  });
});

/**
 * Stated as "may not install an address" this rule kept slipping: a token could switch the column
 * on against an address the owner had already stored, widen it a row at a time, or delete an
 * override that was muting a board — each a standing outbound copy reached by a different verb.
 * Nothing in this repo edits notification preferences with a token, so the surface is withheld
 * whole and there is one thing to audit rather than four conditions to keep in agreement.
 */
describe("who may change notification preferences", () => {
  it.each([
    ["installing an address", { chat: { kind: "slack", webhookUrl: "https://hooks.example/x" } }],
    ["ticking chat against an address the owner stored", { defaults: grid(true) }],
    ["editing the grid at all", { defaults: grid(false) }],
    ["disconnecting", { chat: { kind: "" } }],
  ])("refuses a machine credential %s", async (_label, body) => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put(body);

    expect(res.status).toBe(403);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // Refusing before anything is read also means a machine credential cannot use the validation
  // errors to probe what this instance allows — 400-vs-403 once mapped the webhook allowlist
  it("refuses before validating, so nothing about the instance leaks", async () => {
    caller = { _id: "u1", viaMachineCredential: true };

    const res = await put({ chat: { kind: "slack", webhookUrl: "http://169.254.169.254/x" } });

    expect(res.status).toBe(403);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("where a personal chat connection may point", () => {
  it("checks the address with the webhook destination rule and says why it refused", async () => {
    const res = await put({ chat: { kind: "slack", webhookUrl: "http://10.0.0.5/hook" } });

    expect(isAllowed).toHaveBeenCalledWith("http://10.0.0.5/hook", DESTINATION);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("refused");
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
