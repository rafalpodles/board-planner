import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const save = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById } }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit: vi.fn() }));
vi.mock("@/lib/project-secrets", () => ({
  maskSecretUrl: (u: string) => u,
  sanitizeProjectSecrets: (p: unknown) => p,
}));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "owner1" } }),
}));

const { POST, PUT } = await import("./route");

function request(method: string, body: unknown) {
  return new Request("https://app.example.com/api/projects/p1/webhooks", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

let webhook: { _id: { toString(): string }; url: string; events: string[]; enabled: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  webhook = {
    _id: { toString: () => "w1" },
    url: "https://hooks.example.com/a",
    events: ["task_created"],
    enabled: true,
  };
  findById.mockResolvedValue({
    webhooks: [webhook],
    save,
    toObject: () => ({ webhooks: [webhook] }),
  });
});

describe("POST /api/projects/:projectId/webhooks", () => {
  it("stores a valid url and defaults the events", async () => {
    const res = await POST(request("POST", { url: " https://hooks.example.com/b " }), ctx());

    expect(res.status).toBe(201);
    expect(save).toHaveBeenCalled();
  });

  it("refuses an unknown event name", async () => {
    const res = await POST(
      request("POST", { url: "https://hooks.example.com/b", events: ["not_an_event"] }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

// BP-304: the POST path parsed the url, the PUT path assigned it straight from the body
describe("PUT /api/projects/:projectId/webhooks", () => {
  it("refuses a non-string url", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", url: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(webhook.url).toBe("https://hooks.example.com/a");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a url that does not parse", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", url: "not a url" }), ctx());

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(webhook.events).toEqual(["task_created"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a valid update", async () => {
    const res = await PUT(
      request("PUT", { webhookId: "w1", url: "https://hooks.example.com/c", events: ["comment_added"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(webhook.url).toBe("https://hooks.example.com/c");
    expect(webhook.events).toEqual(["comment_added"]);
    expect(save).toHaveBeenCalled();
  });
});
