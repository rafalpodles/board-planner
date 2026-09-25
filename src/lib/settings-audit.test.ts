import { describe, it, expect } from "vitest";
import { describeSettingsChanges } from "./settings-audit";
import { projectWriteImages } from "./project-write-images";

// Through the real schema, so what is compared is what a write would have stored
function changes(before: Record<string, unknown>, updates: Record<string, unknown>): string[] {
  const images = projectWriteImages(before, updates);
  return describeSettingsChanges(images.before, images.after.toObject(), Object.keys(updates));
}

const FIELD_A = "65a000000000000000000001";
const FIELD_B = "65a000000000000000000002";

describe("describeSettingsChanges", () => {
  it("names each changed setting with its value before and after", () => {
    expect(
      changes(
        { name: "Orbit", description: "", icon: "rocket" },
        { name: "Orbit Two", description: "Ships things", icon: "rocket" }
      )
    ).toEqual(["Name: Orbit → Orbit Two", "Description: none → Ships things"]);
  });

  it("says nothing about a value that was sent unchanged, or blank on both sides", () => {
    expect(changes({ name: "Orbit" }, { name: "Orbit", description: "" })).toEqual([]);
  });

  // The schema trims on write, so the row must not report a difference the database never holds
  it("compares what is stored, not what was sent", () => {
    expect(changes({ name: "Alpha" }, { name: "Alpha " })).toEqual([]);
  });

  // A document written before the host fields existed has none stored, and the form posts the
  // default back on every save: that is no move, and must not read as one
  it("reads a field missing from an older document as its default", () => {
    expect(
      changes({ name: "Orbit" }, { codaHost: "https://coda.io", codaDocId: "doc-1" })
    ).toEqual(["Coda doc: none → doc-1"]);
    expect(changes({ worker: {} }, { "worker.enabled": true })).toEqual(["Workers: off → on"]);
  });

  it("reports a token as set, replaced or cleared, and never its value", () => {
    const lines = [
      ...changes({}, { githubToken: "enc:ghp-new" }),
      ...changes({ gitlabToken: "enc:old" }, { gitlabToken: "enc:glpat-new" }),
      ...changes({ codaToken: "enc:old" }, { codaToken: "" }),
    ];

    expect(lines).toEqual(["GitHub token set", "GitLab token replaced", "Coda token cleared"]);
  });

  it("reads a legacy repository field as the repository it resolves to", () => {
    expect(
      changes(
        { githubRepo: "orbit-dev/orbit" },
        { repositoryUrl: "https://github.com/orbit-dev/orbit-two" }
      )
    ).toEqual(["Repository: https://github.com/orbit-dev/orbit → https://github.com/orbit-dev/orbit-two"]);
  });

  it("keeps the credentials a pasted clone URL carries out of the row", () => {
    const [line] = changes(
      {},
      { repositoryUrl: "https://x-access-token:ghp_secret@github.com/org/app.git?token=abc" }
    );

    expect(line).toBe("Repository: none → https://•••@github.com/org/app.git?•••");
  });

  it("names the estimate field rather than its id", () => {
    const customFields = [
      { _id: FIELD_A, name: "Points", fieldType: "number" },
      { _id: FIELD_B, name: "Hours", fieldType: "number" },
    ];

    expect(changes({ customFields, estimateFieldId: FIELD_A }, { estimateFieldId: FIELD_B })).toEqual(
      ["Estimate field: Points → Hours"]
    );
    expect(changes({ customFields, estimateFieldId: FIELD_A }, { estimateFieldId: "" })).toEqual([
      "Estimate field: Points → none",
    ]);
  });

  it("says whether workers were switched on or off", () => {
    expect(changes({ worker: { enabled: false } }, { "worker.enabled": true })).toEqual([
      "Workers: off → on",
    ]);
  });

  it("keeps an arrow typed into a value from reading as a second change", () => {
    expect(changes({ name: "Board" }, { name: "Board → none" })).toEqual([
      "Name: Board → Board -> none",
    ]);
  });

  it("says a long value changed when the shortened texts would read the same", () => {
    const head = "x".repeat(100);

    expect(changes({ description: `${head} one` }, { description: `${head} two` })).toEqual([
      "Description changed",
    ]);
  });

  it("names a stored field it has no label for, without its values", () => {
    expect(changes({ githubRepo: "a/b" }, { githubRepo: "c/d" })).toEqual(["githubRepo changed"]);
  });

  describe("worker policy", () => {
    it("shows an inherited value as the default it resolves to, not the stored copy", () => {
      const before = { worker: { policy: { runCeilingMs: 3_600_000 }, policyOverrides: [] } };

      expect(
        changes(before, {
          "worker.policy.runCeilingMs": 1_800_000,
          "worker.policyOverrides": ["runCeilingMs"],
        })
      ).toEqual(["Timeout for the whole run (ms): 5400000 (default) → 1800000"]);
    });

    it("shows a reset as going back to the default", () => {
      const before = { worker: { policy: { baseBranch: "develop" }, policyOverrides: ["baseBranch"] } };

      expect(
        changes(before, { "worker.policy.baseBranch": "main", "worker.policyOverrides": [] })
      ).toEqual(["Base branch: develop → main (default)"]);
    });

    it("records pinning the default, which keeps it when the default later moves", () => {
      expect(
        changes(
          { worker: { policyOverrides: [] } },
          { "worker.policy.baseBranch": "main", "worker.policyOverrides": ["baseBranch"] }
        )
      ).toEqual(["Base branch: main (default) → main"]);
    });

    // The overrides list a save sends was computed from an earlier read: a pin another save made in
    // between is dropped by it, and the field goes back to its default without having been named
    it("records a pin a save dropped without naming its field", () => {
      const before = { worker: { policy: { baseBranch: "develop" }, policyOverrides: ["baseBranch"] } };

      expect(
        changes(before, {
          "worker.policy.taskTimeoutMs": 600_000,
          "worker.policyOverrides": ["taskTimeoutMs"],
        })
      ).toEqual([
        "Base branch: develop → main (default)",
        "Timeout for one step (ms): 1800000 (default) → 600000",
      ]);
    });
  });

  describe("the PM agent", () => {
    const github = {
      name: "github",
      url: "https://mcp.example/github",
      authType: "bearer",
      authToken: "enc:secret-one",
      allowWrites: false,
      toolAllowlist: [],
      enabled: true,
    };
    const pm = {
      enabled: true,
      model: "kimi",
      contextNotes: "",
      links: [{ label: "Docs", url: "https://docs.example" }],
      dailyTurnCap: 0,
      dailyTokenCap: 0,
      mcpServers: [github],
      autonomy: {
        dailyReview: false,
        reviewHour: 9,
        reviewIntervalHours: 24,
        timezone: "Europe/Warsaw",
        handleNeedsHumanReview: false,
        lastReviewSlot: "2026-09-25T09",
      },
    };

    it("lists each changed field of the block, and nothing for the rest", () => {
      const next = {
        ...pm,
        autonomy: { ...pm.autonomy, dailyReview: true, reviewHour: 7, lastReviewSlot: "" },
      };

      expect(changes({ pm }, { pm: next })).toEqual([
        "PM scheduled review: off → on",
        "PM first review at: 9 → 7",
      ]);
    });

    it("names MCP servers and their changes without their credentials", () => {
      const next = {
        ...pm,
        mcpServers: [
          { ...github, authToken: "enc:secret-two", allowWrites: true },
          { ...github, name: "linear", url: "https://mcp.example/linear?key=secret-three" },
        ],
      };

      const lines = changes({ pm }, { pm: next });

      expect(lines).toEqual([
        "PM MCP server github · Allow writes: off → on",
        "PM MCP server github · Token replaced",
        "PM MCP server linear added: https://mcp.example/linear?•••, bearer, writes off",
      ]);
      expect(lines.join("\n")).not.toMatch(/secret/);
    });

    it("names a removed MCP server", () => {
      expect(changes({ pm }, { pm: { ...pm, mcpServers: [] } })).toEqual([
        "PM MCP server github removed",
      ]);
    });

    it("records new OAuth client credentials, the secret without its value", () => {
      const connected = {
        ...github,
        authType: "oauth",
        authToken: "",
        oauth: { status: "connected", clientId: "client-1", clientSecret: "enc:one" },
      };
      const before = { pm: { ...pm, mcpServers: [connected] } };
      const next = {
        ...pm,
        mcpServers: [{ ...connected, oauth: { ...connected.oauth, clientId: "client-2", clientSecret: "enc:two" } }],
      };

      expect(changes(before, { pm: next })).toEqual([
        "PM MCP server github · OAuth client: client-1 → client-2",
        "PM MCP server github · OAuth client secret replaced",
      ]);
    });

    it("still says a server changed when the change is in nothing it names", () => {
      const connected = { ...github, authType: "oauth", oauth: { status: "connected", tokenEndpoint: "https://a/token" } };
      const next = { ...pm, mcpServers: [{ ...connected, oauth: { ...connected.oauth, tokenEndpoint: "https://b/token" } }] };

      expect(changes({ pm: { ...pm, mcpServers: [connected] } }, { pm: next })).toEqual([
        "PM MCP server github changed",
      ]);
    });

    it("names links by label and address", () => {
      expect(changes({ pm }, { pm: { ...pm, links: [] } })).toEqual([
        "PM links: Docs (https://docs.example/) → none",
      ]);
    });

    it("reads a project that never had a PM block as starting from the defaults", () => {
      expect(changes({}, { pm: { ...pm, mcpServers: [], links: [] } })).toEqual([
        "PM agent: off → on",
        "PM model: none → kimi",
      ]);
    });

    it("names what a zero cap means rather than printing the zero", () => {
      expect(changes({ pm }, { pm: { ...pm, dailyTurnCap: 50, dailyTokenCap: 200_000 } })).toEqual([
        "PM turns per day: server default → 50",
        "PM tokens per day: no ceiling → 200000",
      ]);
    });

    it("reads an instance admin's single-field change the same way", () => {
      expect(
        changes({ pm: { dailyTurnCap: 40 } }, { "pm.dailyTurnCap": 0, "pm.enabled": true })
      ).toEqual(["PM agent: off → on", "PM turns per day: 40 → server default"]);
    });
  });

  it("shortens a long value rather than writing it whole", () => {
    const [line] = changes({ description: "" }, { description: "x".repeat(500) });

    expect(line.length).toBeLessThan(120);
    expect(line.endsWith("…")).toBe(true);
  });
});
