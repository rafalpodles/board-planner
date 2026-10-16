import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("./safe-fetch", async (importOriginal) => ({ ...(await importOriginal<typeof import("./safe-fetch")>()), safeFetch: m.safeFetch }));
vi.mock("./encryption", () => ({ decryptSecret: (v: string) => v.replace("sealed:", "") }));
vi.mock("./url-validation", () => ({ isAllowedWebhookUrl: (url: string) => url.startsWith("https://"), WEBHOOK_DESTINATION: {} }));

const { postToTeamChannels } = await import("./notifications");

const channels = [
  { type: "slack", name: "team", webhookUrl: "sealed:https://hooks.slack.com/a", enabled: true, events: [] },
  { type: "discord", name: "ops", webhookUrl: "sealed:https://discord.com/api/webhooks/b", enabled: true, events: [] },
  { type: "slack", name: "off", webhookUrl: "sealed:https://hooks.slack.com/c", enabled: false, events: [] },
];
const db = { organisation: "org", Project: { findById: () => ({ lean: async () => ({ notificationChannels: channels }) }) } } as never;

beforeEach(() => m.safeFetch.mockReset());

// BP-870: a summary a person chose to post goes to every enabled channel, whatever events it listens for
describe("postToTeamChannels", () => {
  it("posts to each enabled channel in its own shape, escaping Slack's markup and refusing Discord's mentions", async () => {
    m.safeFetch.mockResolvedValue(new Response("ok"));
    const result = await postToTeamChannels(db, "p1", { slack: "## Standup <!channel> @everyone", discord: "## Standup <!channel> @everyone" });
    expect(result).toEqual({ channels: 2, delivered: 2 });
    const bodies = Object.fromEntries(m.safeFetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]));
    expect(bodies["https://hooks.slack.com/a"]).toEqual({ text: "## Standup &lt;!channel&gt; @everyone" });
    expect(bodies["https://discord.com/api/webhooks/b"]).toEqual({ content: "## Standup <!channel> @everyone", allowed_mentions: { parse: [] } });
    expect(Object.keys(bodies)).not.toContain("https://hooks.slack.com/c");
  });

  it("cuts a long summary to what Discord takes, and counts a channel that refused", async () => {
    m.safeFetch.mockImplementation(async (url: unknown) => new Response("x", { status: String(url).includes("slack") ? 500 : 200 }));
    const result = await postToTeamChannels(db, "p1", { slack: "x", discord: "x".repeat(2500) });
    expect(result).toEqual({ channels: 2, delivered: 1 });
    const discord = m.safeFetch.mock.calls.find(([url]) => String(url).includes("discord"))!;
    expect(JSON.parse(discord[1].body).content).toHaveLength(2000);
  });
});
