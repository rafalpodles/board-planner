import { describe, it, expect, vi, afterEach } from "vitest";

process.env.ENCRYPTION_KEY = "d".repeat(64);

const { maskSecretUrl, sanitizeProjectSecrets } = await import("./project-secrets");
const { encryptSecret } = await import("./encryption");

// Restored here rather than at the end of a test body: an assertion above that line throws and
// leaves console.error mocked for the rest of the file
afterEach(() => vi.restoreAllMocks());

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

  // BP-372: the stored value is an `enc:v2:…` envelope, which `new URL()` parses as a non-special
  // scheme — masking it without decrypting first prints `null/••••` and a tail of ciphertext
  it("masks a stored channel URL by its real host, and never leaks the ciphertext", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = encryptSecret("https://hooks.slack.com/services/T000/B111/abcdef123456");
    const sanitized = sanitizeProjectSecrets({
      notificationChannels: [{ _id: "c1", name: "Releases", webhookUrl: stored, enabled: true }],
    });

    const channel = (sanitized.notificationChannels as Record<string, unknown>[])[0];
    expect(channel.webhookUrlMasked).toBe("https://hooks.slack.com/••••3456");
    expect(channel).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify(channel)).not.toContain(stored.slice(-8));

    // This runs on every project read, list included, so a log outside the catch is production noise
    expect(logged).not.toHaveBeenCalled();
  });

  // The bare mask is also what an unparseable URL gets, so the screen cannot tell the two apart.
  // Naming the row in the log is the only thing that makes a lost key actionable.
  it("falls back to a bare mask when no configured key can read the stored URL, and says which row", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unreadable = (name = "Unreadable row") =>
      sanitizeProjectSecrets({
        key: "BP",
        notificationChannels: [
          { _id: "c1", name, webhookUrl: "enc:v2:deadbeef:Zm9v", enabled: true },
        ],
      });

    const sanitized = unreadable();

    const channel = (sanitized.notificationChannels as Record<string, unknown>[])[0];
    expect(channel.webhookUrlMasked).toBe("••••");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("BP"));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Unreadable row"));

    // The board polls a project every 10 seconds per open tab and the sidebar maps this over the
    // whole list, so the row is reported once per process rather than once per read — a key that
    // is never coming back would otherwise bill for a log line for ever.
    logged.mockClear();
    unreadable();
    unreadable();
    expect(logged).not.toHaveBeenCalled();

    // Still the same row after a rename. Keyed on the name, this would report again — and an owner
    // trying to fix a broken channel renames it, so that is the worst moment to start repeating.
    unreadable("Renamed while trying to fix it");
    expect(logged).not.toHaveBeenCalled();
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
