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
