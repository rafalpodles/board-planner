import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findOne = vi.fn();
const findOneAndUpdate = vi.fn();
const exists = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById, findOne, findOneAndUpdate, exists } }));
const logProjectAudit = vi.fn();
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/project-secrets", () => ({
  maskSecretUrl: (u: string | undefined) => (u ? `masked(${u})` : ""),
  // Shaped like the real one for webhooks, so a response that skipped it would show
  sanitizeProjectSecrets: (p: { webhooks?: { url?: string }[] }) => ({
    ...p,
    webhooks: p.webhooks?.map(({ url, ...rest }) => ({ ...rest, urlMasked: url ? `masked(${url})` : "" })),
  }),
}));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "owner1" } }),
}));

const { POST, PUT, DELETE } = await import("./route");

function request(method: string, body?: unknown) {
  return new Request("https://app.example.com/api/projects/p1/webhooks", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

const W1 = "6a70afff45d39cd9bc8bb5a1";

const webhook = {
  _id: W1,
  url: "https://hooks.example.com/a",
  events: ["task_created"],
  enabled: true,
};

function projectDoc(webhooks: unknown[]) {
  return { webhooks, toObject: () => ({ webhooks }) };
}

// Awaited as it is by POST, or through .lean() by the writers that keep their before-image
function query(result: unknown) {
  return Object.assign(Promise.resolve(result), { lean: () => Promise.resolve(result) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Answers, rather than being left undefined, so the three assertions below fail on the
  // assertion itself if a writer starts loading the project — not on a crash inside the route.
  findById.mockResolvedValue(projectDoc([webhook]));
  findOneAndUpdate.mockImplementation(() => query(projectDoc([webhook])));
  findOne.mockReturnValue({ lean: () => Promise.resolve({ webhooks: [webhook] }) });
});

describe("POST /api/projects/:projectId/webhooks", () => {
  it("stores a valid url and defaults the events", async () => {
    const res = await POST(request("POST", { url: " https://hooks.example.com/b " }), ctx());

    expect(res.status).toBe(201);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "webhooks.19": { $exists: false } },
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

  // The $push is atomic and single-round-trip on purpose (BP-407): the old load→mutate→save()
  // shape re-sent the whole array on every write, which raced dispatchWebhooks recording a
  // delivery outcome on a different webhook in the same project and silently dropped it.
  it("never calls Project.findById, the load half of load-mutate-save", async () => {
    await POST(request("POST", { url: "https://hooks.example.com/b" }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    exists.mockResolvedValue(null);

    const res = await POST(request("POST", { url: "https://hooks.example.com/b" }), ctx());

    expect(res.status).toBe(404);
  });

  // BP-323: one card move fires every webhook, so thousands at one host are a flood from this instance
  it("refuses a webhook past the cap, with the cap in the match so a race cannot pass it", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    exists.mockResolvedValue({ _id: "p1" });

    const res = await POST(request("POST", { url: "https://hooks.example.com/b" }), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("A project can have at most 20 webhooks");
  });

  it("refuses a URL longer than 2048 characters", async () => {
    const url = `https://hooks.example.com/${"a".repeat(2048)}`;

    const res = await POST(request("POST", { url }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// BP-304: the POST path parsed the url, the PUT path assigned it straight from the body
describe("PUT /api/projects/:projectId/webhooks", () => {
  it("refuses a non-string url, without writing anything", async () => {
    const res = await PUT(request("PUT", { webhookId: W1, url: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a url that does not parse", async () => {
    const res = await PUT(request("PUT", { webhookId: W1, url: "not a url" }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses events that are not a list of known events", async () => {
    const res = await PUT(request("PUT", { webhookId: W1, events: ["nope"] }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts a valid update, targeting the one webhook by id atomically", async () => {
    const res = await PUT(
      request("PUT", { webhookId: W1, url: "https://hooks.example.com/c", events: ["comment_added"] }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": W1 },
      {
        $set: {
          "webhooks.$.url": "https://hooks.example.com/c",
          "webhooks.$.events": ["comment_added"],
        },
      },
      { returnDocument: "before" }
    );
  });

  it("never calls Project.findById, the load half of load-mutate-save", async () => {
    await PUT(request("PUT", { webhookId: W1, enabled: false }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the id matches no webhook on this project", async () => {
    findOneAndUpdate.mockImplementation(() => query(null));

    const res = await PUT(request("PUT", { webhookId: "6a70afff45d39cd9bc8bb5ff", enabled: false }), ctx());

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:projectId/webhooks", () => {
  it("removes the named webhook atomically", async () => {
    const res = await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1" },
      { $pull: { webhooks: { _id: W1 } } },
      { returnDocument: "before" }
    );
  });

  it("never calls Project.findById, the load half of load-mutate-save", async () => {
    await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    findOneAndUpdate.mockImplementation(() => query(null));

    const res = await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    expect(res.status).toBe(404);
  });
});

describe("where a webhook may point", () => {
  it.each(["http://127.0.0.1:3990/hook", "https://10.0.0.5/hook", "http://hooks.example.com/b"])(
    "refuses %s on create and on edit, before anything is written",
    async (url) => {
      const created = await POST(request("POST", { url }), ctx());
      const edited = await PUT(request("PUT", { webhookId: W1, url }), ctx());

      for (const res of [created, edited]) {
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/must be https and reachable on the public internet/);
      }
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    }
  );
});

// BP-782: re-pointing a webhook, or switching it off, decides where board events go, and left no trace
describe("what a webhook edit records", () => {
  it("records each change from the write's own before-image, with the address masked", async () => {
    const res = await PUT(
      request("PUT", {
        webhookId: W1,
        url: "https://hooks.example.com/c",
        events: ["task_created", "comment_added"],
        enabled: false,
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    const was = "Webhook masked(https://hooks.example.com/a)";
    expect(logProjectAudit).toHaveBeenCalledWith("p1", "owner1", "settings_updated", [
      `${was} · URL: masked(https://hooks.example.com/a) → masked(https://hooks.example.com/c)`,
      `${was} · Events: task_created → comment_added, task_created`,
      `${was} · Enabled: on → off`,
    ]);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("records nothing when what was sent is what was stored", async () => {
    await PUT(request("PUT", { webhookId: W1, events: ["task_created"], enabled: true }), ctx());

    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("answers with the list as the write left it, addresses masked", async () => {
    const res = await PUT(request("PUT", { webhookId: W1, enabled: false }), ctx());

    const { url, ...rest } = webhook;
    expect(await res.json()).toEqual([{ ...rest, enabled: false, urlMasked: `masked(${url})` }]);
  });

  it("names a removed webhook from the pull's own before-image", async () => {
    const res = await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    expect(await res.json()).toEqual([]);

    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "owner1",
      "settings_updated",
      "Webhook removed: masked(https://hooks.example.com/a)"
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it("answers a removal with the addresses left, masked", async () => {
    const other = { ...webhook, _id: "6a70afff45d39cd9bc8bb5a2", url: "https://hooks.example.com/b" };
    findOneAndUpdate.mockImplementation(() => query(projectDoc([webhook, other])));

    const res = await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    const { url, ...rest } = other;
    expect(await res.json()).toEqual([{ ...rest, urlMasked: `masked(${url})` }]);
  });

  it("records no removal of a webhook that was already gone", async () => {
    findOneAndUpdate.mockImplementation(() => query(projectDoc([])));

    const res = await DELETE(request("DELETE", { webhookId: W1 }), ctx());

    expect(res.status).toBe(200);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("refuses an id that is not one, before writing anything", async () => {
    const res = await PUT(request("PUT", { webhookId: { $ne: null }, enabled: false }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// Review: BSON reads hex case-insensitively while a stored id prints in lower case, so an id sent in
// upper case wrote through Mongo's cast and then matched nothing in the before-image — no trace
describe("an id sent in upper case", () => {
  it("is written and recorded under the id as stored", async () => {
    const res = await PUT(request("PUT", { webhookId: W1.toUpperCase(), enabled: false }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": W1 },
      { $set: { "webhooks.$.enabled": false } },
      { returnDocument: "before" }
    );
    expect(logProjectAudit).toHaveBeenCalledWith("p1", "owner1", "settings_updated", [
      "Webhook masked(https://hooks.example.com/a) · Enabled: on → off",
    ]);
  });

  it("is removed and recorded under the id as stored", async () => {
    await DELETE(request("DELETE", { webhookId: W1.toUpperCase() }), ctx());

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "p1" },
      { $pull: { webhooks: { _id: W1 } } },
      { returnDocument: "before" }
    );
    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "owner1",
      "settings_updated",
      "Webhook removed: masked(https://hooks.example.com/a)"
    );
  });
});
