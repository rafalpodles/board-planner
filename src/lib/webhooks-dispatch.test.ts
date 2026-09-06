import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./webhook-signature";

const safeFetch = vi.fn();
const findById = vi.fn();
const updateOne = vi.fn().mockResolvedValue({});

vi.mock("./safe-fetch", () => ({
  safeFetch,
  BlockedDestinationError: class BlockedDestinationError extends Error {},
}));
vi.mock("@/models/project", () => ({ Project: { findById, updateOne } }));

const { dispatchWebhooks } = await import("./webhooks");

const SECRET = "shhh";
const ORIGINAL = process.env.WEBHOOK_SIGNING_SECRET;

const PAYLOAD = {
  project: { key: "TP", name: "A board" },
  task: { taskKey: "TP-1", title: "A task", status: "todo" },
};

function project(webhooks: Record<string, unknown>[]) {
  findById.mockReturnValue({ lean: () => Promise.resolve({ webhooks }) });
}

function hook(over: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/hook",
    events: ["task_created", "status_changed"],
    enabled: true,
    ...over,
  };
}

function deliveries(): [string, RequestInit][] {
  return safeFetch.mock.calls.map((call) => [call[0] as string, call[1] as RequestInit]);
}

function headerOf(init: RequestInit, name: string): string {
  return (init.headers as Record<string, string>)[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBHOOK_SIGNING_SECRET = SECRET;
  safeFetch.mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
  else process.env.WEBHOOK_SIGNING_SECRET = ORIGINAL;
});

describe("dispatchWebhooks", () => {
  it("signs the body it actually sends, over the timestamp it actually states", async () => {
    project([hook()]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    const [[url, init]] = deliveries();
    expect(url).toBe("https://example.com/hook");
    expect(init.method).toBe("POST");

    const timestamp = headerOf(init, TIMESTAMP_HEADER);
    const signature = headerOf(init, SIGNATURE_HEADER);
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${timestamp}.${String(init.body)}`)
      .digest("hex");
    expect(signature).toBe(`t=${timestamp},v1=${expected}`);

    expect(Math.abs(Date.now() - Number(timestamp) * 1000)).toBeLessThan(60_000);

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ event: "task_created", ...PAYLOAD });
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });

  it("signs every delivery, not only the first", async () => {
    project([hook(), hook({ url: "https://elsewhere.example/hook" })]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    const sent = deliveries();
    expect(sent.map(([url]) => url)).toEqual([
      "https://example.com/hook",
      "https://elsewhere.example/hook",
    ]);
    for (const [, init] of sent) {
      const timestamp = headerOf(init, TIMESTAMP_HEADER);
      const expected = crypto
        .createHmac("sha256", SECRET)
        .update(`${timestamp}.${String(init.body)}`)
        .digest("hex");
      expect(headerOf(init, SIGNATURE_HEADER)).toBe(`t=${timestamp},v1=${expected}`);
    }
    expect(sent[0][1].headers, "the second delivery carries its own headers").not.toBe(
      sent[1][1].headers
    );
  });

  it("delivers unsigned rather than not at all when no secret is configured", async () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;
    project([hook()]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    const [[, init]] = deliveries();
    expect(headerOf(init, SIGNATURE_HEADER)).toBeUndefined();
    expect(headerOf(init, TIMESTAMP_HEADER)).toBeUndefined();
    expect(init.body).toContain("task_created");
  });

  it("sends only to the webhooks that are enabled and subscribed to this event", async () => {
    project([
      hook({ url: "https://subscribed.example/hook" }),
      hook({ url: "https://disabled.example/hook", enabled: false }),
      hook({ url: "https://other-events.example/hook", events: ["comment_added"] }),
    ]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(deliveries().map(([url]) => url)).toEqual(["https://subscribed.example/hook"]);
  });

  it("judges the destination per webhook, so one bad row does not take the others with it", async () => {
    project([
      hook({ url: "http://plain.example/hook" }),
      hook({ url: "https://localhost/hook" }),
      hook({ url: "https://127.0.0.1/hook" }),
      hook({ url: "https://fine.example/hook" }),
    ]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(deliveries().map(([url]) => url)).toEqual(["https://fine.example/hook"]);
  });

  it("does not wait for the receiver", async () => {
    project([hook()]);
    let land!: (value: Response) => void;
    safeFetch.mockReturnValue(new Promise<Response>((resolve) => (land = resolve)));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(deliveries()).toHaveLength(1);
    land(new Response("{}", { status: 200 }));
  });

  it("says nothing to anybody when the project has no webhooks", async () => {
    project([]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });
});
