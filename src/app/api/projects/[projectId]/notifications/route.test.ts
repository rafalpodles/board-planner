import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { PUT } = await import("./route");

function request(body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/notifications", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

let channel: { _id: { toString(): string }; name: string; webhookUrl: string; events: string[]; enabled: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  channel = {
    _id: { toString: () => "c1" },
    name: "Slack",
    webhookUrl: "https://hooks.slack.com/a",
    events: ["task_created"],
    enabled: true,
  };
  findById.mockResolvedValue({
    notificationChannels: [channel],
    save,
    toObject: () => ({ notificationChannels: [channel] }),
  });
});

// BP-304: the POST path parsed the url and checked the type, the PUT path assigned
// name, webhookUrl and events straight from the body
describe("PUT /api/projects/:projectId/notifications", () => {
  it("refuses a non-string webhookUrl", async () => {
    const res = await PUT(request({ channelId: "c1", webhookUrl: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request({ channelId: "c1", events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const res = await PUT(request({ channelId: "c1", name: "   " }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a valid update", async () => {
    const res = await PUT(
      request({ channelId: "c1", name: "Ops", webhookUrl: "https://hooks.slack.com/b", events: ["status_changed"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(channel.name).toBe("Ops");
    expect(channel.webhookUrl).toBe("https://hooks.slack.com/b");
    expect(channel.events).toEqual(["status_changed"]);
    expect(save).toHaveBeenCalled();
  });
});
