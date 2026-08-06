import { describe, it, expect } from "vitest";
import { maskSecretUrl, sanitizeProjectSecrets } from "./project-secrets";

describe("maskSecretUrl", () => {
  it("keeps the origin and the last four characters of a Slack webhook", () => {
    expect(maskSecretUrl("https://hooks.slack.com/services/T000/B111/abcdef123456")).toBe(
      "https://hooks.slack.com/••••3456"
    );
  });

  it("masks a Discord webhook the same way", () => {
    expect(maskSecretUrl("https://discord.com/api/webhooks/123456/tokenABCD")).toBe(
      "https://discord.com/••••ABCD"
    );
  });

  // A value that does not parse must not be echoed back on the assumption it is harmless
  it("returns a bare mask for something that is not a URL", () => {
    expect(maskSecretUrl("not a url at all")).toBe("••••");
  });

  it("returns an empty string when nothing is set", () => {
    expect(maskSecretUrl("")).toBe("");
    expect(maskSecretUrl(undefined)).toBe("");
  });

  it("omits the tail when the value is too short to spare four characters", () => {
    expect(maskSecretUrl("https://x.co/a")).toBe("https://x.co/••••");
  });
});

describe("sanitizeProjectSecrets", () => {
  it("replaces each integration token with a boolean and removes it", () => {
    const sanitized = sanitizeProjectSecrets({
      name: "Test",
      githubToken: "ghp_aaa",
      gitlabToken: "glpat_bbb",
      codaToken: "coda_ccc",
    });

    expect(sanitized).toMatchObject({
      name: "Test",
      githubTokenSet: true,
      gitlabTokenSet: true,
      codaTokenSet: true,
    });
    expect(sanitized).not.toHaveProperty("githubToken");
    expect(sanitized).not.toHaveProperty("gitlabToken");
    expect(sanitized).not.toHaveProperty("codaToken");
  });

  it("reports a token as unset rather than omitting the flag", () => {
    const sanitized = sanitizeProjectSecrets({ name: "Test" });

    expect(sanitized).toMatchObject({
      githubTokenSet: false,
      gitlabTokenSet: false,
      codaTokenSet: false,
    });
  });

  it("masks a notification channel's webhook URL and removes the original", () => {
    const sanitized = sanitizeProjectSecrets({
      notificationChannels: [
        {
          _id: "c1",
          type: "slack",
          name: "Releases",
          webhookUrl: "https://hooks.slack.com/services/T000/B111/abcdef123456",
          events: ["task_created"],
          enabled: true,
        },
      ],
    });

    const channel = (sanitized.notificationChannels as Record<string, unknown>[])[0];
    expect(channel).toMatchObject({
      _id: "c1",
      name: "Releases",
      enabled: true,
      webhookUrlMasked: "https://hooks.slack.com/••••3456",
    });
    expect(channel).not.toHaveProperty("webhookUrl");
  });

  it("masks an outgoing webhook's URL and removes the original", () => {
    const sanitized = sanitizeProjectSecrets({
      webhooks: [
        { _id: "w1", url: "https://example.com/hooks/secret-path-9876", enabled: true },
      ],
    });

    const webhook = (sanitized.webhooks as Record<string, unknown>[])[0];
    expect(webhook).toMatchObject({
      _id: "w1",
      enabled: true,
      urlMasked: "https://example.com/••••9876",
    });
    expect(webhook).not.toHaveProperty("url");
  });

  // Every board older than CP-246 still stores owner and admins: the schema paths went away with
  // no backfill, and Mongoose keeps unmapped keys in _doc, which toObject() clones whole. All three
  // project serialisation paths funnel through here, so this is the one place that can stop them.
  it("drops the legacy owner and admins keys a pre-CP-246 document still carries", () => {
    const sanitized: Record<string, unknown> = sanitizeProjectSecrets({
      _id: "p1",
      name: "Legacy board",
      key: "LEG",
      createdBy: null,
      owner: "507f1f77bcf86cd799439011",
      admins: ["507f1f77bcf86cd799439012"],
    });

    expect(sanitized).not.toHaveProperty("owner");
    expect(sanitized).not.toHaveProperty("admins");
    expect(sanitized).toMatchObject({ _id: "p1", name: "Legacy board", key: "LEG", createdBy: null });
  });

  it("leaves a project with no channels or webhooks alone", () => {
    const sanitized: Record<string, unknown> = sanitizeProjectSecrets({ name: "Bare" });

    expect(sanitized.notificationChannels).toBeUndefined();
    expect(sanitized.webhooks).toBeUndefined();
  });
});
