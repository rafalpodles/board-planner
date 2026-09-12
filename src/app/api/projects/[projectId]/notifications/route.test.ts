import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "a".repeat(64);
process.env.ENCRYPTION_KEY = KEY;

const findById = vi.fn();
const save = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));
vi.mock("@/lib/project-secrets", () => ({ sanitizeProjectSecrets: (p: unknown) => p }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "owner1" } }),
}));

const { PUT, POST } = await import("./route");
const { decryptSecret } = await import("@/lib/encryption");

function request(method: string, body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/notifications", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

let channel: { _id: { toString(): string }; name: string; webhookUrl: string; events: string[]; enabled: boolean };
let project: { notificationChannels: typeof channel[]; save: typeof save; toObject: () => unknown };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = KEY;
  channel = {
    _id: { toString: () => "c1" },
    name: "Slack",
    webhookUrl: "https://hooks.slack.com/a",
    events: ["task_created"],
    enabled: true,
  };
  project = {
    notificationChannels: [channel],
    save,
    toObject: () => ({ notificationChannels: [channel] }),
  };
  findById.mockResolvedValue(project);
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

// BP-304: the POST path parsed the url and checked the type, the PUT path assigned
// name, webhookUrl and events straight from the body
describe("PUT /api/projects/:projectId/notifications", () => {
  it("refuses a non-string webhookUrl", async () => {
    const res = await PUT(request("PUT", { channelId: "c1", webhookUrl: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request("PUT", { channelId: "c1", events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const res = await PUT(request("PUT", { channelId: "c1", name: "   " }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a valid update", async () => {
    const res = await PUT(
      request("PUT", { channelId: "c1", name: "Ops", webhookUrl: "https://hooks.slack.com/b", events: ["status_changed"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(channel.name).toBe("Ops");
    expect(channel.events).toEqual(["status_changed"]);
    expect(save).toHaveBeenCalled();
  });

  // BP-372
  it("stores a replacement URL encrypted, never the URL itself", async () => {
    await PUT(request("PUT", { channelId: "c1", webhookUrl: "https://hooks.slack.com/b" }), ctx());

    expect(channel.webhookUrl).not.toContain("hooks.slack.com");
    expect(channel.webhookUrl).not.toBe("https://hooks.slack.com/b");
    expect(decryptSecret(channel.webhookUrl)).toBe("https://hooks.slack.com/b");
  });

  it("refuses a replacement URL when no encryption key is configured", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await PUT(request("PUT", { channelId: "c1", webhookUrl: "https://hooks.slack.com/b" }), ctx());

    expect(res.status).toBe(503);
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  // A row written before BP-372 holds the URL in the clear; any save carries it over
  it("upgrades a plaintext URL when some other field is edited", async () => {
    const res = await PUT(request("PUT", { channelId: "c1", name: "Ops" }), ctx());

    expect(res.status).toBe(200);
    expect(channel.webhookUrl).not.toContain("hooks.slack.com");
    expect(decryptSecret(channel.webhookUrl)).toBe("https://hooks.slack.com/a");
  });

  it("re-encrypts nothing when the stored URL is already encrypted", async () => {
    const { encryptSecret } = await import("@/lib/encryption");
    channel.webhookUrl = encryptSecret("https://hooks.slack.com/a");
    const before = channel.webhookUrl;

    await PUT(request("PUT", { channelId: "c1", name: "Ops" }), ctx());

    expect(channel.webhookUrl).toBe(before);
  });

  it("still edits a channel's name on an instance with no key, leaving the plaintext alone", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await PUT(request("PUT", { channelId: "c1", name: "Ops" }), ctx());

    expect(res.status).toBe(200);
    expect(channel.name).toBe("Ops");
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
  });
});

describe("POST /api/projects/:projectId/notifications", () => {
  // BP-372
  it("stores the webhook URL encrypted", async () => {
    const res = await POST(
      request("POST", { type: "slack", name: "Releases", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(res.status).toBe(201);
    const added = project.notificationChannels[1];
    expect(added.webhookUrl).not.toContain("hooks.slack.com");
    expect(decryptSecret(added.webhookUrl)).toBe("https://hooks.slack.com/new");
    expect(JSON.stringify(project.notificationChannels)).not.toContain("hooks.slack.com/new");
  });

  it("refuses to add a channel when no encryption key is configured", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await POST(
      request("POST", { type: "slack", name: "Releases", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(res.status).toBe(503);
    expect(project.notificationChannels).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });
});
