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
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
  BlockedDestinationError: class BlockedDestinationError extends Error {},
}));
const allowUrl = vi.fn().mockReturnValue(true);
vi.mock("@/lib/url-validation", () => ({ isAllowedWebhookUrl: (u: string) => allowUrl(u) }));

const { dispatchWebhooks } = await import("./webhooks");
const { BlockedDestinationError } = await import("@/lib/safe-fetch");

function project(webhooks: Record<string, unknown>[]) {
  return { webhooks };
}

const PAYLOAD = { project: { key: "BP", name: "Board Planner" } };

type Call = [
  { _id: string; webhooks: { $elemMatch: { _id: string; $or: unknown[] } } },
  { $set: Record<string, unknown> },
];

function callsFor(webhookId: string) {
  return (updateOne.mock.calls as unknown as Call[]).filter(
    (c) => c[0].webhooks.$elemMatch._id === webhookId
  );
}

beforeEach(() => {
  findByIdLean.mockReset();
  updateOne.mockClear();
  safeFetch.mockReset();
  allowUrl.mockReturnValue(true);
});

describe("what a successful delivery records", () => {
  it("stamps ok, clears any earlier error, and matches the right webhook by id", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    const [filter, update] = callsFor("w1")[0];
    expect(filter._id).toBe("p1");
    expect(filter.webhooks.$elemMatch._id).toBe("w1");
    expect(update.$set).toEqual({
      "webhooks.$.lastAttemptAt": expect.any(Date),
      "webhooks.$.lastStatus": "ok",
      "webhooks.$.lastError": "",
    });
  });
});

describe("what a failed delivery records", () => {
  it("stamps failed with the network error when the request itself rejects", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    expect(callsFor("w1")[0][1].$set).toEqual({
      "webhooks.$.lastAttemptAt": expect.any(Date),
      "webhooks.$.lastStatus": "failed",
      "webhooks.$.lastError": "connect ECONNREFUSED",
    });
  });

  // The original code's `.catch(() => {})` only ever saw a REJECTED promise — a receiver that
  // answers with a plain 500 resolves `safeFetch` normally, so this was recorded as a success.
  it("stamps failed on a non-2xx response, not just a rejected promise", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    expect(callsFor("w1")[0][1].$set["webhooks.$.lastError"]).toBe("HTTP 500");
  });

  // safeFetch's BlockedDestinationError names exactly why a destination was refused — "resolves to
  // the private address X" — which is precisely what the SSRF guard exists to keep from whoever
  // chose that URL. Recording it verbatim would turn a blind refusal into a reconnaissance oracle.
  it("does not persist the detail from a blocked-destination error", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockRejectedValue(new BlockedDestinationError("10.0.0.5 resolves to the private address 10.0.0.5"));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    const written = callsFor("w1")[0][1].$set["webhooks.$.lastError"] as string;
    expect(written).not.toContain("10.0.0.5");
    expect(written).toBe("Blocked destination");
  });

  // Refused before ever reaching the network is still an attempt: without recording it, a URL
  // that stops passing this check (edited to something disallowed, or DNS moved) reads as "still
  // delivering" on the settings page forever, because nothing ever writes over the last success.
  it("records an outcome even when the destination check itself refuses the URL", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    allowUrl.mockReturnValue(false);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    expect(safeFetch).not.toHaveBeenCalled();
    expect(callsFor("w1")[0][1].$set["webhooks.$.lastStatus"]).toBe("failed");
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
    await vi.waitFor(() => {
      expect(callsFor("w-ok")).toHaveLength(1);
      expect(callsFor("w-fail")).toHaveLength(1);
    });

    expect(callsFor("w-ok")[0][1].$set["webhooks.$.lastStatus"]).toBe("ok");
    expect(callsFor("w-fail")[0][1].$set["webhooks.$.lastStatus"]).toBe("failed");
  });
});

describe("ordering against a concurrent attempt on the same webhook", () => {
  // Two events firing close together for one webhook can settle out of order — an older, slower
  // attempt landing its write after a newer, faster one's would otherwise overwrite it. The guard
  // is in the query filter itself ($elemMatch with an $or on lastAttemptAt), asserted here by
  // shape since only a real MongoDB evaluates whether it actually excludes a stale write — that was
  // verified separately against a live instance.
  it("scopes the write to a webhook whose recorded attempt is not already newer", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    safeFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhooks("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));

    const [filter] = callsFor("w1")[0];
    expect(filter.webhooks.$elemMatch.$or).toEqual([
      { lastAttemptAt: null },
      { lastAttemptAt: { $lte: expect.any(Date) } },
    ]);
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
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));
  });

  it("returns before the delivery it started has resolved", async () => {
    findByIdLean.mockResolvedValue(
      project([{ _id: "w1", url: "https://a.example/hook", events: ["task_created"], enabled: true }])
    );
    // Held open deliberately: if dispatchWebhooks awaited the delivery chain, this call would
    // never resolve, and the test itself would time out — the only way this test can fail for the
    // right reason. A settled mock, unlike the earlier Date.now() check, can't pass by accident.
    let releaseDelivery!: (v: { ok: boolean; status: number }) => void;
    safeFetch.mockReturnValue(new Promise((resolve) => (releaseDelivery = resolve)));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(updateOne).not.toHaveBeenCalled();
    releaseDelivery({ ok: true, status: 200 });
    await vi.waitFor(() => expect(callsFor("w1")).toHaveLength(1));
  });
});
