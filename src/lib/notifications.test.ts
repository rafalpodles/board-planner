import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "b".repeat(64);
const OTHER_KEY = "c".repeat(64);
process.env.ENCRYPTION_KEY = KEY;

const findById = vi.fn();
const safeFetch = vi.fn((url: string, init?: RequestInit) => {
  void url;
  void init;
  return Promise.resolve(new Response("ok"));
});

vi.mock("@/models/project", () => ({ Project: { findById } }));
vi.mock("./safe-fetch", () => ({ safeFetch }));

const { dispatchNotifications } = await import("./notifications");
const { encryptSecret } = await import("./encryption");

const PAYLOAD = { project: { key: "BP", name: "Board" }, task: { taskKey: "BP-1", title: "T", status: "todo" } };

function projectWith(...urls: string[]) {
  findById.mockReturnValue({
    lean: () =>
      Promise.resolve({
        notificationChannels: urls.map((webhookUrl, i) => ({
          type: "slack",
          name: `Channel ${i}`,
          webhookUrl,
          events: ["task_created"],
          enabled: true,
        })),
      }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = KEY;
  delete process.env.ENCRYPTION_KEYS_OLD;
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
  delete process.env.ENCRYPTION_KEYS_OLD;
});

describe("dispatchNotifications", () => {
  // BP-372
  it("posts to the URL a stored ciphertext decrypts to, not to the ciphertext", async () => {
    projectWith(encryptSecret("https://hooks.slack.com/services/T/B/secret"));

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/secret");
  });

  // Rows written before BP-372 carry no envelope and must keep working with no migration
  it("posts to a legacy plaintext URL unchanged", async () => {
    projectWith("https://hooks.slack.com/services/T/B/legacy");

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/legacy");
  });

  it("reads a value written by a retired key", async () => {
    const written = encryptSecret("https://hooks.slack.com/services/T/B/rotated");
    process.env.ENCRYPTION_KEYS_OLD = KEY;
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    projectWith(written);

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/rotated");
  });

  // Skipping is per channel: an unreadable one must not take the rest of the board's channels
  // down with it, which is what letting decryptSecret throw into the outer catch would do
  it("skips only the channel whose URL no configured key can read", async () => {
    const lost = encryptSecret("https://hooks.slack.com/services/T/B/lost");
    process.env.ENCRYPTION_KEYS_OLD = OTHER_KEY;
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    projectWith(lost, encryptSecret("https://hooks.slack.com/services/T/B/readable"));

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/readable");
  });

  it("still refuses a decrypted URL the allowlist rejects", async () => {
    projectWith(encryptSecret("http://127.0.0.1/internal"));

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });
});
