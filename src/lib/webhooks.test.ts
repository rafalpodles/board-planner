import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./webhook-signature";

/**
 * BP-396. `signWebhook` had a test; *dispatch* had none — so nothing established that a delivery
 * carries the signature at all, that only an enabled webhook subscribed to this event is sent one,
 * or that the destination guard is applied per webhook rather than once for the list.
 *
 * This is the only level at which the signature can be asserted: a delivery cannot be received in
 * the e2e run, because `safeFetch` takes https and a public address only (BP-408). `safe-fetch` is
 * the seam, so everything above it — selection, body, headers — is the real module.
 *
 * It is also the only level at which `isAllowedWebhookUrl`'s own branches are covered.
 * `safe-fetch.test.ts` exercises `assertPublicDestination`, which is the *second* gate; the first
 * is this module's, and with `safeFetch` mocked here there is no socket and no TLS to confuse a
 * refusal with a failed handshake — which is why the e2e spec cannot make this assertion and this
 * file can.
 */

const safeFetch = vi.fn();
const findById = vi.fn();

vi.mock("./safe-fetch", () => ({ safeFetch }));
vi.mock("@/models/project", () => ({ Project: { findById } }));

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

/** Every delivery, as (url, RequestInit) pairs. */
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
    // Recomputed from the body that went out, rather than pattern-matched: a signature over a
    // different body, or over a timestamp other than the one the header states, is the whole
    // failure mode the header exists to prevent (BP-306)
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${timestamp}.${String(init.body)}`)
      .digest("hex");
    expect(signature).toBe(`t=${timestamp},v1=${expected}`);

    // The timestamp is read from the header, so the assertion above establishes only that the two
    // agree. What the value *is* matters as much: a delivery stamped t=0 verifies perfectly and
    // sits outside every receiver's replay window — the decoration webhook-signature.ts warns of.
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
    // Recomputed for each rather than shape-matched: two `toMatch(/^t=\d+,v1=…/)` assertions are
    // satisfied by a second delivery carrying the first one's header object, which is the mistake
    // worth catching here
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
    // An instance that never configured a secret has receivers that do not check; dropping their
    // deliveries would be the worse bug
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
      // One row per branch of isAllowedWebhookUrl. The name is not a duplicate of the literal:
      // `localhost` is not an address, so `isPrivateAddress` says nothing about it and only
      // `isInternalName` refuses it — a branch nothing else in the repository covers.
      hook({ url: "http://plain.example/hook" }),
      hook({ url: "https://localhost/hook" }),
      hook({ url: "https://127.0.0.1/hook" }),
      hook({ url: "https://fine.example/hook" }),
    ]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(deliveries().map(([url]) => url)).toEqual(["https://fine.example/hook"]);
  });

  // Deliberately not "the failure is caught": dispatchWebhooks does not await its own fetch, so a
  // resolved call says nothing about the `.catch()` being there, and vitest has already handled a
  // mocked rejection. What this does establish is that the caller is not made to wait.
  it("does not wait for the receiver", async () => {
    project([hook()]);
    let land!: (value: Response) => void;
    safeFetch.mockReturnValue(new Promise<Response>((resolve) => (land = resolve)));

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(deliveries()).toHaveLength(1);
    land(new Response("{}", { status: 200 }));
    // Nothing retries a failure and nothing records that an attempt happened — BP-407
  });

  it("says nothing to anybody when the project has no webhooks", async () => {
    project([]);

    await dispatchWebhooks("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });
});
