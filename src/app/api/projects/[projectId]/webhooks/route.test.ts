import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findOne = vi.fn();
const findOneAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById, findOne, findOneAndUpdate } }));
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

const { GET, POST, PUT, DELETE } = await import("./route");

function request(method: string, body?: unknown) {
  return new Request("https://app.example.com/api/projects/p1/webhooks", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

const webhook = {
  _id: { toString: () => "w1" },
  url: "https://hooks.example.com/a",
  events: ["task_created"],
  enabled: true,
};

function projectDoc(webhooks: unknown[]) {
  return { webhooks, toObject: () => ({ webhooks }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue(projectDoc([webhook]));
  findOneAndUpdate.mockResolvedValue(projectDoc([webhook]));
  findOne.mockReturnValue({ lean: () => Promise.resolve({ webhooks: [webhook] }) });
});

describe("GET /api/projects/:projectId/webhooks", () => {
  it("404s when the project does not exist", async () => {
    findById.mockResolvedValue(null);

    const res = await GET(request("GET"), ctx());

    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/:projectId/webhooks", () => {
  it("stores a valid url and defaults the events", async () => {
    const res = await POST(request("POST", { url: " https://hooks.example.com/b " }), ctx());

    expect(res.status).toBe(201);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1" },
      {
        $push: {
          webhooks: { url: "https://hooks.example.com/b", events: expect.any(Array), enabled: true },
        },
      },
      { returnDocument: "after" }
    );
  });

  it("refuses an unknown event name, without writing anything", async () => {
    const res = await POST(
      request("POST", { url: "https://hooks.example.com/b", events: ["not_an_event"] }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("never loads the project into memory first", async () => {
    await POST(request("POST", { url: "https://hooks.example.com/b" }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    const res = await POST(request("POST", { url: "https://hooks.example.com/b" }), ctx());

    expect(res.status).toBe(404);
  });
});

describe("PUT /api/projects/:projectId/webhooks", () => {
  it("refuses a non-string url, without writing anything", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", url: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a url that does not parse", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", url: "not a url" }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request("PUT", { webhookId: "w1", events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts a valid update, targeting the one webhook by id atomically", async () => {
    const res = await PUT(
      request("PUT", { webhookId: "w1", url: "https://hooks.example.com/c", events: ["comment_added"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": "w1" },
      {
        $set: {
          "webhooks.$.url": "https://hooks.example.com/c",
          "webhooks.$.events": ["comment_added"],
        },
      },
      { returnDocument: "after" }
    );
  });

  it("never loads the project into memory first", async () => {
    await PUT(request("PUT", { webhookId: "w1", enabled: false }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the id matches no webhook on this project", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    const res = await PUT(request("PUT", { webhookId: "gone", enabled: false }), ctx());

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:projectId/webhooks", () => {
  it("removes the named webhook atomically", async () => {
    const res = await DELETE(request("DELETE", { webhookId: "w1" }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1" },
      { $pull: { webhooks: { _id: "w1" } } },
      { returnDocument: "after" }
    );
  });

  it("never loads the project into memory first", async () => {
    await DELETE(request("DELETE", { webhookId: "w1" }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    const res = await DELETE(request("DELETE", { webhookId: "w1" }), ctx());

    expect(res.status).toBe(404);
  });
});
