import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MAX_NOTIFICATION_CHANNELS } from "@/lib/webhook-input";

const KEY = "a".repeat(64);
process.env.ENCRYPTION_KEY = KEY;

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const exists = vi.fn();
const save = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById, findOneAndUpdate, exists } }));
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
    toObject: () => ({ notificationChannels: project.notificationChannels }),
  };
  findById.mockResolvedValue(project);
  // The ceiling-miss path re-checks this to tell "full" from "deleted out from under the
  // request" apart (review) — true by default, since every existing scenario's project is there.
  exists.mockResolvedValue(true);
  // The add is an atomic $push with the ceiling in its filter, so the stub applies the write
  // the way the database would — including refusing it once the array is full.
  findOneAndUpdate.mockImplementation(
    async (filter: Record<string, unknown>, update: { $push: { notificationChannels: typeof channel } }) => {
      const full = project.notificationChannels.length >= MAX_NOTIFICATION_CHANNELS;
      if (`notificationChannels.${MAX_NOTIFICATION_CHANNELS - 1}` in filter && full) return null;
      project.notificationChannels = [...project.notificationChannels, update.$push.notificationChannels];
      return project;
    }
  );
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

  // A single module-level NextResponse carries a one-shot ReadableStream: returning it twice
  // leaves the second caller a 503 with no body, and two at once lock the stream into a 500
  it("says why it refused on every request, not only the first", async () => {
    delete process.env.ENCRYPTION_KEY;
    const ask = () =>
      PUT(request("PUT", { channelId: "c1", webhookUrl: "https://hooks.slack.com/b" }), ctx());

    const first = await ask();
    const second = await ask();
    const [third, fourth] = await Promise.all([ask(), ask()]);

    for (const res of [first, second, third, fourth]) {
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("ENCRYPTION_KEY") });
    }
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
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  // BP-323, tightened by BP-719: the count was read against the document loaded above the
  // write, so every concurrent racer saw the same pre-write length and N of them together
  // landed the array past the cap. The ceiling now lives in the write's own filter instead.
  it(`refuses a channel past the cap of ${MAX_NOTIFICATION_CHANNELS}`, async () => {
    project.notificationChannels = Array.from({ length: MAX_NOTIFICATION_CHANNELS }, () => ({ ...channel }));

    const res = await POST(
      request("POST", { type: "slack", name: "One more", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(project.notificationChannels).toHaveLength(MAX_NOTIFICATION_CHANNELS);
  });

  // A ceiling-filter miss also fires when the project was deleted between the earlier findById
  // and this write — the two must not both read as "full" (review).
  it("404s, not 400, when the project vanished between the read and the write", async () => {
    project.notificationChannels = Array.from({ length: MAX_NOTIFICATION_CHANNELS }, () => ({ ...channel }));
    exists.mockResolvedValue(false);

    const res = await POST(
      request("POST", { type: "slack", name: "One more", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
  });

  it(`still adds the ${MAX_NOTIFICATION_CHANNELS}th`, async () => {
    project.notificationChannels = Array.from({ length: MAX_NOTIFICATION_CHANNELS - 1 }, () => ({ ...channel }));

    const res = await POST(
      request("POST", { type: "slack", name: "The last one", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(res.status).toBe(201);
    expect(project.notificationChannels).toHaveLength(MAX_NOTIFICATION_CHANNELS);
  });

  // The bound is in the write's own filter, not in a count read against the document loaded
  // above it — this is the one that would go red if the ceiling ever moved back to a count read.
  it("carries the ceiling in the write filter rather than checking it beforehand", async () => {
    await POST(
      request("POST", { type: "slack", name: "Releases", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", [`notificationChannels.${MAX_NOTIFICATION_CHANNELS - 1}`]: { $exists: false } },
      { $push: { notificationChannels: expect.objectContaining({ name: "Releases", type: "slack" }) } },
      { returnDocument: "after" }
    );
  });

  it("does not re-send the whole array", async () => {
    await POST(
      request("POST", { type: "slack", name: "Releases", webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );

    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a name longer than 100 characters, on create and on edit", async () => {
    const created = await POST(
      request("POST", { type: "slack", name: "n".repeat(101), webhookUrl: "https://hooks.slack.com/new" }),
      ctx()
    );
    const edited = await PUT(request("PUT", { channelId: "c1", name: "n".repeat(101) }), ctx());

    expect(created.status).toBe(400);
    expect(edited.status).toBe(400);
    expect(channel.name).toBe("Slack");
    expect(save).not.toHaveBeenCalled();
  });
});
