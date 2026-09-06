import { describe, it, expect, vi } from "vitest";

const safeFetch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));
vi.mock("@/lib/url-validation", () => ({ isAllowedWebhookUrl: () => true }));
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

describe("what the message may not do", () => {
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
