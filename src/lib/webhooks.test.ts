import { describe, it, expect, vi, beforeEach } from "vitest";

const findByIdLean = vi.fn();
const updateOne = vi.fn().mockResolvedValue({});
vi.mock("@/models/project", () => ({
  Project: {
    findById: () => ({ lean: findByIdLean }),
    updateOne: (...a: unknown[]) => updateOne(...a),
  },
}));

const safeFetch = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));
vi.mock("@/lib/url-validation", () => ({ isAllowedWebhookUrl: () => true }));

const { dispatchWebhooks } = await import("./webhooks");

function project(webhooks: Record<string, unknown>[]) {
  return { webhooks };
}

const PAYLOAD = { project: { key: "BP", name: "Board Planner" } };

// dispatchWebhooks fires the HTTP request and returns without waiting for it — none of its three
// call sites in task-service.ts await it either, so recording the outcome has to happen on its own
// time. `flush()` drains that background chain so the test can assert what it wrote.
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  findByIdLean.mockReset();
  updateOne.mockClear();
  safeFetch.mockReset();
});

describe("what a successful delivery records", () => {
  it("stamps ok, clears any earlier error, and matches the right webhook by id", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await flush();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": "w1" },
      {
        $set: {
          "webhooks.$.lastAttemptAt": expect.any(Date),
          "webhooks.$.lastStatus": "ok",
          "webhooks.$.lastError": "",
        },
      }
    );
  });
});

describe("what a failed delivery records", () => {
  it("stamps failed with the network error when the request itself rejects", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await flush();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": "w1" },
      {
        $set: {
          "webhooks.$.lastAttemptAt": expect.any(Date),
          "webhooks.$.lastStatus": "failed",
          "webhooks.$.lastError": "connect ECONNREFUSED",
        },
      }
    );
  });

  // The original code's `.catch(() => {})` only ever saw a REJECTED promise — a receiver that
  // answers with a plain 500 resolves `safeFetch` normally, so this was recorded as a success.
  it("stamps failed on a non-2xx response, not just a rejected promise", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await flush();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "webhooks._id": "w1" },
      {
        $set: {
          "webhooks.$.lastAttemptAt": expect.any(Date),
          "webhooks.$.lastStatus": "failed",
          "webhooks.$.lastError": "HTTP 500",
        },
      }
    );
  });
});

describe("multiple webhooks on the same event", () => {
  it("records each outcome against its own id, not the other one's", async () => {
    findByIdLean.mockResolvedValue(
      project([
        { _id: "w-ok", url: "https://a.example/hook", events: ["task_created"], enabled: true },
        { _id: "w-fail", url: "https://b.example/hook", events: ["task_created"], enabled: true },
      ])
    );
    safeFetch.mockImplementation((url: string) =>
      url.includes("a.example")
        ? Promise.resolve({ ok: true, status: 200 })
        : Promise.reject(new Error("timeout"))
    );

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await flush();

    type Call = [{ "webhooks._id": string }, { $set: Record<string, unknown> }];
    const calls = updateOne.mock.calls as unknown as Call[];
    expect(calls.map((c) => c[0]["webhooks._id"]).sort()).toEqual(["w-fail", "w-ok"]);
    const statusFor = (id: string) => calls.find((c) => c[0]["webhooks._id"] === id)?.[1].$set;
    expect(statusFor("w-ok")?.["webhooks.$.lastStatus"]).toBe("ok");
    expect(statusFor("w-fail")?.["webhooks.$.lastStatus"]).toBe("failed");
  });
});

describe("recording the outcome is itself fire-and-forget", () => {
  it("a failure to write the outcome does not throw out of dispatchWebhooks", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
    updateOne.mockRejectedValueOnce(new Error("database is unreachable"));

    await expect(dispatchWebhooks("p1", "task_created", PAYLOAD)).resolves.toBeUndefined();
    await flush();
  });

  it("does not skip or delay delivery to wait for the write", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: true, status: 200 });

    const started = Date.now();
    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
