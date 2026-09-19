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
  channelsOf("slack", ["task_created"], ...urls);
}

function channelsOf(type: "slack" | "discord", events: string[], ...urls: string[]) {
  findById.mockReturnValue({
    lean: () =>
      Promise.resolve({
        notificationChannels: urls.map((webhookUrl, i) => ({
          type,
          name: `Channel ${i}`,
          webhookUrl,
          events,
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
  // Restored here rather than at the end of a test body: an assertion above that line throws and
  // leaves console.error mocked for the rest of the file
  vi.restoreAllMocks();
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
  it("skips only the channel whose URL no configured key can read, and names it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const lost = encryptSecret("https://hooks.slack.com/services/T/B/lost");
    process.env.ENCRYPTION_KEYS_OLD = OTHER_KEY;
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    projectWith(lost, encryptSecret("https://hooks.slack.com/services/T/B/readable"));

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/readable");

    // Which one went quiet, not just that something did: with a dozen boards, a bare
    // "could not be decrypted" names no row to go and fix
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("p1"));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Channel 0"));
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("Channel 1"));
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("still refuses a decrypted URL the allowlist rejects", async () => {
    projectWith(encryptSecret("http://127.0.0.1/internal"));

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });
});

// BP-426: the shared channel is posted to a room by anyone who can create a task or comment
describe("dispatchNotifications — markup in what members write", () => {
  const PHISH = "<https://phish.example|Reset your password>";
  const sentBody = () => JSON.parse(String(safeFetch.mock.calls[0][1]?.body));

  it("sends a Slack link in a task title as text, not as a link", async () => {
    channelsOf("slack", ["task_created"], "https://hooks.slack.com/services/T/B/x");

    await dispatchNotifications("p1", "task_created", {
      project: { key: "BP", name: "Board" },
      task: { taskKey: "BP-1", title: `Fix login ${PHISH}`, status: "todo" },
    });

    const text = JSON.stringify(sentBody());
    expect(text).not.toContain("<https://phish.example");
    expect(text).toContain("&lt;https://phish.example|Reset your password&gt;");
    // The task link the message exists to carry still works
    expect(text).toContain("<http://localhost:3000/projects/BP/tasks/BP-1|BP-1>");
  });

  it("sends a Slack link in a comment body as text", async () => {
    channelsOf("slack", ["comment_added"], "https://hooks.slack.com/services/T/B/x");

    await dispatchNotifications("p1", "comment_added", {
      ...PAYLOAD,
      data: { commentBody: `see ${PHISH}`, author: "anna" },
    });

    const text = JSON.stringify(sentBody());
    expect(text).not.toContain("<https://phish.example");
    expect(text).toContain("see &lt;https://phish.example|Reset your password&gt;");
  });

  it("does not let a Discord comment ping the room or forge markdown", async () => {
    channelsOf("discord", ["comment_added"], "https://discord.com/api/webhooks/1/x");

    await dispatchNotifications("p1", "comment_added", {
      ...PAYLOAD,
      data: { commentBody: "@everyone **URGENT** [reset](https://phish.example)", author: "anna" },
    });

    const sent = sentBody();
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    expect(sent.embeds[0].description).toBe(
      "@everyone \\*\\*URGENT\\*\\* \\[reset\\]\\(https://phish.example\\)"
    );
  });

  it("escapes a Discord task title and cuts a long comment before escaping it", async () => {
    channelsOf("discord", ["task_created", "comment_added"], "https://discord.com/api/webhooks/1/x");

    await dispatchNotifications("p1", "task_created", {
      project: { key: "BP", name: "Board" },
      task: { taskKey: "BP-1", title: "# Headline **bold**", status: "todo" },
    });
    expect(sentBody().embeds[0].description).toBe("\\# Headline \\*\\*bold\\*\\*");
    expect(sentBody().allowed_mentions).toEqual({ parse: [] });

    safeFetch.mockClear();
    await dispatchNotifications("p1", "comment_added", {
      ...PAYLOAD,
      data: { commentBody: `${"a".repeat(199)}*tail`, author: "anna" },
    });
    // The 200th character is the `*`, so an escape added after the cut would leave `\` dangling
    expect(sentBody().embeds[0].description).toBe(`${"a".repeat(199)}\\*...`);
  });
});

describe("dispatchNotifications — every value and every event", () => {
  const sentBody = (n = 0) => JSON.parse(String(safeFetch.mock.calls[n][1]?.body));

  it("escapes the project, the old column, the author and the key on Slack", async () => {
    channelsOf("slack", ["status_changed", "comment_added"], "https://hooks.slack.com/services/T/B/x");

    await dispatchNotifications("p1", "status_changed", {
      project: { key: "B|P", name: "<!channel> Board" },
      task: { taskKey: "BP-1", title: "T", status: "todo" },
      data: { oldStatus: "<@U123> column" },
    });
    await dispatchNotifications("p1", "comment_added", {
      project: { key: "BP", name: "Board" },
      task: { taskKey: "BP-1", title: "T", status: "todo" },
      data: { commentBody: "x", author: "<https://phish.example|admin>" },
    });

    const status = JSON.stringify(sentBody(0));
    expect(status).not.toContain("<!channel>");
    expect(status).not.toContain("<@U123>");
    expect(status).toContain("/projects/B%7CP/tasks/BP-1|BP-1>");
    const comment = JSON.stringify(sentBody(1));
    expect(comment).not.toContain("<https://phish.example");
  });

  it("escapes the author on Discord", async () => {
    channelsOf("discord", ["comment_added"], "https://discord.com/api/webhooks/1/x");

    await dispatchNotifications("p1", "comment_added", {
      ...PAYLOAD,
      data: { commentBody: "x", author: "**admin**" },
    });

    expect(sentBody().embeds[0].fields[0].value).toBe("\\*\\*admin\\*\\*");
  });

  it.each(["task_created", "status_changed", "comment_added"])(
    "refuses mentions on a Discord %s message",
    async (event) => {
      channelsOf("discord", [event], "https://discord.com/api/webhooks/1/x");

      await dispatchNotifications("p1", event as never, { ...PAYLOAD, data: { oldStatus: "todo", commentBody: "x" } });

      expect(sentBody().allowed_mentions).toEqual({ parse: [] });
    }
  );

  // BP-323: a project with many channels opened a request to every one at once
  it("has at most four channel deliveries in flight at once", async () => {
    const landers: ((r: Response) => void)[] = [];
    safeFetch.mockImplementation(() => new Promise<Response>((resolve) => landers.push(resolve)));
    channelsOf("slack", ["task_created"], ...Array.from({ length: 9 }, (_, i) => `https://hooks.slack.com/services/T/B/${i}`));

    await dispatchNotifications("p1", "task_created", PAYLOAD);
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(safeFetch).toHaveBeenCalledTimes(4);

    landers.shift()!(new Response("ok"));
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(5));
    safeFetch.mockImplementation(() => Promise.resolve(new Response("ok")));
  });
});

// BP-472: `active` is computed by `ch.enabled && ch.events.includes(event)` — each half of that
// filter needs its own case, or a mutation that drops either side of the `&&` still passes.
describe("dispatchNotifications — which channels are eligible", () => {
  function channels(...rows: { enabled: boolean; events: string[]; name: string }[]) {
    findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          notificationChannels: rows.map((row, i) => ({
            type: "slack",
            name: row.name,
            webhookUrl: encryptSecret(`https://hooks.slack.com/services/T/B/${i}`),
            events: row.events,
            enabled: row.enabled,
          })),
        }),
    });
  }

  it("skips a disabled channel even when it is subscribed to the event", async () => {
    channels({ enabled: false, events: ["task_created"], name: "Disabled" });

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("skips a channel not subscribed to the event even when it is enabled", async () => {
    channels({ enabled: true, events: ["task_moved"], name: "Wrong event" });

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("delivers to an enabled channel subscribed to the event, alongside ones that are not", async () => {
    channels(
      { enabled: false, events: ["task_created"], name: "Disabled" },
      { enabled: true, events: ["task_moved"], name: "Wrong event" },
      { enabled: true, events: ["task_created"], name: "Eligible" }
    );

    await dispatchNotifications("p1", "task_created", PAYLOAD);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T/B/2");
  });
});
