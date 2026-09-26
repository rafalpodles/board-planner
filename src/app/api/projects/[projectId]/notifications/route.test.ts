import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MAX_NOTIFICATION_CHANNELS } from "@/lib/webhook-input";

const KEY = "a".repeat(64);
process.env.ENCRYPTION_KEY = KEY;

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const exists = vi.fn();
const save = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById, findOneAndUpdate, updateOne, exists } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/project-secrets", () => ({ sanitizeProjectSecrets: (p: unknown) => p }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "owner1" } }),
}));

const { PUT, POST, DELETE } = await import("./route");
const { decryptSecret } = await import("@/lib/encryption");

function request(method: string, body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/notifications", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

const C1 = "6a70afff45d39cd9bc8bb5c1";

let channel: { _id: string; name: string; webhookUrl: string; events: string[]; enabled: boolean };
let project: { notificationChannels: typeof channel[]; save: typeof save; toObject: () => unknown };

// Awaited as it is by POST, or through .lean() by the writers that keep their before-image
function query(result: unknown) {
  return Object.assign(Promise.resolve(result), { lean: () => Promise.resolve(result) });
}

const image = () =>
  JSON.parse(JSON.stringify({ _id: "p1", key: "TP", notificationChannels: project.notificationChannels }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = KEY;
  channel = {
    _id: C1,
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
  // Every writer is one atomic operation, so the stub applies each the way the database would:
  // the add refused once the array is full, the edit and the removal answering their before-image
  findOneAndUpdate.mockImplementation(
    (
      filter: Record<string, unknown>,
      update: {
        $push?: { notificationChannels: typeof channel };
        $set?: Record<string, unknown>;
        $pull?: { notificationChannels: { _id: string } };
      }
    ) => {
      if (update.$push) {
        const full = project.notificationChannels.length >= MAX_NOTIFICATION_CHANNELS;
        if (`notificationChannels.${MAX_NOTIFICATION_CHANNELS - 1}` in filter && full) return query(null);
        project.notificationChannels = [...project.notificationChannels, update.$push.notificationChannels];
        return query(project);
      }
      const before = image();
      if (update.$pull) {
        project.notificationChannels = project.notificationChannels.filter(
          (ch) => ch._id !== update.$pull!.notificationChannels._id
        );
        return query(before);
      }
      const target = project.notificationChannels.find((ch) => ch._id === filter["notificationChannels._id"]);
      if (!target) return query(null);
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        (target as Record<string, unknown>)[path.split(".$.")[1]] = value;
      }
      return query(before);
    }
  );
  updateOne.mockImplementation(
    async (
      filter: { notificationChannels: { $elemMatch: { _id: string; webhookUrl: string } } },
      update: { $set: Record<string, string> }
    ) => {
      const { _id, webhookUrl } = filter.notificationChannels.$elemMatch;
      const target = project.notificationChannels.find((ch) => ch._id === _id && ch.webhookUrl === webhookUrl);
      if (!target) return { modifiedCount: 0 };
      target.webhookUrl = update.$set["notificationChannels.$.webhookUrl"];
      return { modifiedCount: 1 };
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
    const res = await PUT(request("PUT", { channelId: C1, webhookUrl: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request("PUT", { channelId: C1, events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const res = await PUT(request("PUT", { channelId: C1, name: "   " }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a valid update", async () => {
    const res = await PUT(
      request("PUT", { channelId: C1, name: "Ops", webhookUrl: "https://hooks.slack.com/b", events: ["status_changed"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(channel.name).toBe("Ops");
    expect(channel.events).toEqual(["status_changed"]);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "notificationChannels._id": C1 },
      { $set: expect.objectContaining({ "notificationChannels.$.name": "Ops" }) },
      { returnDocument: "before" }
    );
    expect(save).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  // BP-372
  it("stores a replacement URL encrypted, never the URL itself", async () => {
    await PUT(request("PUT", { channelId: C1, webhookUrl: "https://hooks.slack.com/b" }), ctx());

    expect(channel.webhookUrl).not.toContain("hooks.slack.com");
    expect(channel.webhookUrl).not.toBe("https://hooks.slack.com/b");
    expect(decryptSecret(channel.webhookUrl)).toBe("https://hooks.slack.com/b");
  });

  it("refuses a replacement URL when no encryption key is configured", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await PUT(request("PUT", { channelId: C1, webhookUrl: "https://hooks.slack.com/b" }), ctx());

    expect(res.status).toBe(503);
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  // A single module-level NextResponse carries a one-shot ReadableStream: returning it twice
  // leaves the second caller a 503 with no body, and two at once lock the stream into a 500
  it("says why it refused on every request, not only the first", async () => {
    delete process.env.ENCRYPTION_KEY;
    const ask = () =>
      PUT(request("PUT", { channelId: C1, webhookUrl: "https://hooks.slack.com/b" }), ctx());

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
    const res = await PUT(request("PUT", { channelId: C1, name: "Ops" }), ctx());

    expect(res.status).toBe(200);
    expect(channel.webhookUrl).not.toContain("hooks.slack.com");
    expect(decryptSecret(channel.webhookUrl)).toBe("https://hooks.slack.com/a");
  });

  it("re-encrypts nothing when the stored URL is already encrypted", async () => {
    const { encryptSecret } = await import("@/lib/encryption");
    channel.webhookUrl = encryptSecret("https://hooks.slack.com/a");
    const before = channel.webhookUrl;

    await PUT(request("PUT", { channelId: C1, name: "Ops" }), ctx());

    expect(channel.webhookUrl).toBe(before);
  });

  it("still edits a channel's name on an instance with no key, leaving the plaintext alone", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await PUT(request("PUT", { channelId: C1, name: "Ops" }), ctx());

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
    const edited = await PUT(request("PUT", { channelId: C1, name: "n".repeat(101) }), ctx());

    expect(created.status).toBe(400);
    expect(edited.status).toBe(400);
    expect(channel.name).toBe("Slack");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("where a project chat channel may point", () => {
  it.each(["http://127.0.0.1:3990/hook", "https://10.0.0.5/hook", "http://hooks.slack.com/x"])(
    "refuses %s on create and on edit, before anything is written",
    async (webhookUrl) => {
      const created = await POST(request("POST", { type: "slack", name: "Releases", webhookUrl }), ctx());
      const edited = await PUT(request("PUT", { channelId: C1, webhookUrl }), ctx());

      for (const res of [created, edited]) {
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/must be https and reachable on the public internet/);
      }
      expect(findOneAndUpdate).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    }
  );
});

// BP-782: a team channel's name, events and address were edited with no trace in the audit log
describe("what a channel edit records", () => {
  it("names each change from the write's before-image, and never the webhook URL", async () => {
    await PUT(
      request("PUT", {
        channelId: C1,
        name: "Ops",
        webhookUrl: "https://hooks.slack.com/b",
        events: ["status_changed"],
        enabled: false,
      }),
      ctx()
    );

    expect(logProjectAudit).toHaveBeenCalledWith("p1", "owner1", "settings_updated", [
      "Notification channel Slack · Name: Slack → Ops",
      "Notification channel Slack · Webhook URL replaced",
      "Notification channel Slack · Events: task_created → status_changed",
      "Notification channel Slack · Enabled: on → off",
    ]);
    expect(JSON.stringify(logProjectAudit.mock.calls)).not.toContain("hooks.slack.com");
  });

  it("does not call the address it already had a replacement", async () => {
    const { encryptSecret } = await import("@/lib/encryption");
    channel.webhookUrl = encryptSecret("https://hooks.slack.com/a");

    await PUT(request("PUT", { channelId: C1, webhookUrl: "https://hooks.slack.com/a" }), ctx());

    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("records nothing for the cleartext upgrade alone", async () => {
    await PUT(request("PUT", { channelId: C1, enabled: true }), ctx());

    expect(decryptSecret(channel.webhookUrl)).toBe("https://hooks.slack.com/a");
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("upgrades only the address it read: one replaced in between is left as it is", async () => {
    const through = updateOne.getMockImplementation()!;
    updateOne.mockImplementationOnce(async (...args: Parameters<typeof through>) => {
      channel.webhookUrl = "replaced by another save";
      return through(...args);
    });

    const res = await PUT(request("PUT", { channelId: C1, name: "Ops" }), ctx());

    expect(res.status).toBe(200);
    expect(channel.webhookUrl).toBe("replaced by another save");
  });

  it("tells a channel that is not there from a project that is not", async () => {
    const missingChannel = await PUT(
      request("PUT", { channelId: "6a70afff45d39cd9bc8bb5ff", name: "Ops" }),
      ctx()
    );
    exists.mockResolvedValue(null);
    const missingProject = await PUT(
      request("PUT", { channelId: "6a70afff45d39cd9bc8bb5ff", name: "Ops" }),
      ctx()
    );

    expect([missingChannel.status, missingProject.status]).toEqual([404, 404]);
    expect((await missingChannel.json()).error).toBe("Channel not found");
    expect((await missingProject.json()).error).toBe("Project not found");
  });

  it("refuses an id that is not one, before writing anything", async () => {
    const res = await PUT(request("PUT", { channelId: { $ne: null }, name: "Ops" }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/:projectId/notifications", () => {
  it("pulls the channel in one write and names it from that write's before-image", async () => {
    const res = await DELETE(request("DELETE", { channelId: C1 }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1" },
      { $pull: { notificationChannels: { _id: C1 } } },
      { returnDocument: "before" }
    );
    expect(findById).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "owner1",
      "settings_updated",
      "Notification channel removed: Slack"
    );
    expect(await res.json()).toEqual([]);
  });

  it("records no removal of a channel that was already gone", async () => {
    project.notificationChannels = [];

    const res = await DELETE(request("DELETE", { channelId: C1 }), ctx());

    expect(res.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    findOneAndUpdate.mockImplementation(() => query(null));

    const res = await DELETE(request("DELETE", { channelId: C1 }), ctx());

    expect(res.status).toBe(404);
  });
});
