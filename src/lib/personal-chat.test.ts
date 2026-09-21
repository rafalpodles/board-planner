import { describe, it, expect, vi } from "vitest";

const safeFetch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));
const DESTINATION = { allowLoopback: "the webhook destination" };
const isAllowed = vi.fn().mockReturnValue(true);
vi.mock("@/lib/url-validation", () => ({
  WEBHOOK_DESTINATION: DESTINATION,
  isAllowedWebhookUrl: (u: string, o: unknown) => isAllowed(u, o),
}));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => v }));
vi.mock("@/lib/session", () => ({ selfOrigin: () => "https://app.example.com" }));

const { sendPersonalChat } = await import("@/lib/personal-chat");

const slackUser = {
  _id: "u1",
  notifications: { chat: { kind: "slack" as const, webhookUrl: "https://hooks.example/x" } },
};

function bodySent() {
  return JSON.parse((safeFetch.mock.calls.at(-1)?.[1] as { body: string }).body);
}

describe("a personal chat message", () => {
  // A title can close the link Slack is asked to draw, and open one of its own — in a channel the
  // reader trusts, from a sender they trust. Anyone who can rename a task could do it.
  it("cannot close the link it is placed inside", async () => {
    safeFetch.mockClear();

    await sendPersonalChat({
      users: [slackUser],
      type: "mentioned",
      title: '> <https://phish.example|Click here',
      email: { kicker: "", taskKey: "BP-1", taskTitle: "", projectRef: "BP", taskNumber: 1 },
    });

    const text = bodySent().text as string;
    expect(text).not.toContain("<https://phish.example|");
    expect(text).toContain("&gt;");
  });

  it("still links the task it is about", async () => {
    safeFetch.mockClear();

    await sendPersonalChat({
      users: [slackUser],
      type: "task_assigned",
      title: "Ordinary title",
      email: { kicker: "", taskKey: "BP-1", taskTitle: "", projectRef: "BP", taskNumber: 1 },
    });

    expect(bodySent().text).toContain("<https://app.example.com/projects/BP/tasks/1|Ordinary title>");
  });
});

// BP-753: board_access is about a board, so its link is the board rather than no link at all
describe("a message about a board", () => {
  it("links the board", async () => {
    safeFetch.mockClear();

    await sendPersonalChat({
      users: [slackUser],
      type: "board_access",
      title: "Olga added you to Orbit as a member",
      email: { kicker: "", taskKey: "ORB", taskTitle: "Orbit", projectRef: "ORB" },
    });

    expect(bodySent().text).toBe(
      "*Your access to a board changed*\n<https://app.example.com/projects/ORB|Olga added you to Orbit as a member>"
    );
  });
});

describe("what the message may not do", () => {
  // The URL half carries project.key, which this instance constrains nowhere — so a project owner
  // choosing a key is choosing part of the link expression
  it("cannot close the link from the URL half either", async () => {
    safeFetch.mockClear();

    await sendPersonalChat({
      users: [slackUser],
      type: "mentioned",
      title: "Ordinary title",
      email: {
        kicker: "",
        taskKey: "X-1",
        taskTitle: "",
        projectRef: "A><https://phish.example|Reset your password",
        taskNumber: 1,
      },
    });

    const text = bodySent().text as string;
    expect(text).not.toContain("><https://phish.example|");
  });

  it("does not let a title ping a Discord channel", async () => {
    safeFetch.mockClear();
    const discordUser = {
      _id: "u2",
      notifications: { chat: { kind: "discord" as const, webhookUrl: "https://hooks.example/d" } },
    };

    await sendPersonalChat({
      users: [discordUser],
      type: "task_assigned",
      title: "@everyone **Assigned to you** look here",
      email: { kicker: "", taskKey: "BP-1", taskTitle: "", projectRef: "BP", taskNumber: 1 },
    });

    const body = bodySent();
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).not.toContain("**Assigned to you** look here");
  });
});

// BP-323: one event reaching many people opened a request to every personal webhook at once
describe("personal chat fan-out", () => {
  it("has at most four deliveries in flight at once", async () => {
    safeFetch.mockClear();
    const landers: ((v: unknown) => void)[] = [];
    safeFetch.mockImplementation(() => new Promise((resolve) => landers.push(resolve)));

    await sendPersonalChat({
      users: Array.from({ length: 9 }, (_, i) => ({ ...slackUser, _id: `u${i}` })),
      type: "mentioned",
      title: "T",
    });
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(safeFetch).toHaveBeenCalledTimes(4);

    landers.shift()!({ ok: true });
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(5));
    safeFetch.mockImplementation(() => Promise.resolve({ ok: true }));
  });
});

describe("where a personal chat message may go", () => {
  it("checks and fetches with the webhook destination rule", async () => {
    safeFetch.mockClear();
    isAllowed.mockClear();

    await sendPersonalChat({ users: [slackUser], type: "mentioned", title: "T" });

    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(1));
    expect(isAllowed).toHaveBeenCalledWith("https://hooks.example/x", DESTINATION);
    expect(safeFetch.mock.calls[0][2]).toBe(DESTINATION);
  });
});
