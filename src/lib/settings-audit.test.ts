import { describe, it, expect } from "vitest";
import { describeSettingsChanges } from "./settings-audit";

describe("describeSettingsChanges", () => {
  it("names each changed setting with its value before and after", () => {
    expect(
      describeSettingsChanges(
        { name: "Orbit", description: "", icon: "rocket" },
        { name: "Orbit Two", description: "Ships things", icon: "rocket" }
      )
    ).toEqual(["Name: Orbit → Orbit Two", "Description: none → Ships things"]);
  });

  it("says nothing about a value that was sent unchanged, or blank on both sides", () => {
    expect(
      describeSettingsChanges({ name: "Orbit" }, { name: "Orbit", description: "" })
    ).toEqual([]);
  });

  it("reports a token as set, replaced or cleared, and never its value", () => {
    const lines = [
      ...describeSettingsChanges({}, { githubToken: "enc:ghp-new" }),
      ...describeSettingsChanges({ gitlabToken: "enc:old" }, { gitlabToken: "enc:glpat-new" }),
      ...describeSettingsChanges({ codaToken: "enc:old" }, { codaToken: "" }),
    ];

    expect(lines).toEqual(["GitHub token set", "GitLab token replaced", "Coda token cleared"]);
  });

  it("reads a legacy repository field as the repository it resolves to", () => {
    expect(
      describeSettingsChanges(
        { githubRepo: "orbit-dev/orbit" },
        { repositoryUrl: "https://github.com/orbit-dev/orbit-two" }
      )
    ).toEqual(["Repository: https://github.com/orbit-dev/orbit → https://github.com/orbit-dev/orbit-two"]);
  });

  it("names the estimate field rather than its id", () => {
    const customFields = [
      { _id: "f1", name: "Points" },
      { _id: "f2", name: "Hours" },
    ];

    expect(
      describeSettingsChanges({ customFields, estimateFieldId: "f1" }, { estimateFieldId: "f2" })
    ).toEqual(["Estimate field: Points → Hours"]);
    expect(
      describeSettingsChanges({ customFields, estimateFieldId: "f1" }, { estimateFieldId: "" })
    ).toEqual(["Estimate field: Points → none"]);
  });

  it("says whether workers were switched on or off", () => {
    expect(
      describeSettingsChanges({ worker: { enabled: false } }, { "worker.enabled": true })
    ).toEqual(["Workers: off → on"]);
  });

  describe("worker policy", () => {
    it("shows an inherited value as the default it resolves to, not the stored copy", () => {
      const before = { worker: { policy: { runCeilingMs: 3_600_000 }, policyOverrides: [] } };

      expect(
        describeSettingsChanges(before, {
          "worker.policy.runCeilingMs": 1_800_000,
          "worker.policyOverrides": ["runCeilingMs"],
        })
      ).toEqual(["Timeout for the whole run (ms): 5400000 (default) → 1800000"]);
    });

    it("shows a reset as going back to the default", () => {
      const before = {
        worker: { policy: { baseBranch: "develop" }, policyOverrides: ["baseBranch"] },
      };

      expect(
        describeSettingsChanges(before, {
          "worker.policy.baseBranch": "main",
          "worker.policyOverrides": [],
        })
      ).toEqual(["Base branch: develop → main (default)"]);
    });

    it("records pinning the default, which keeps it when the default later moves", () => {
      expect(
        describeSettingsChanges(
          { worker: { policyOverrides: [] } },
          { "worker.policy.baseBranch": "main", "worker.policyOverrides": ["baseBranch"] }
        )
      ).toEqual(["Base branch: main (default) → main"]);
    });
  });

  describe("the PM agent", () => {
    const pm = {
      enabled: true,
      model: "kimi",
      contextNotes: "",
      links: [{ label: "Docs", url: "https://docs.example" }],
      dailyTurnCap: 0,
      dailyTokenCap: 0,
      mcpServers: [
        {
          name: "github",
          url: "https://mcp.example/github",
          authType: "bearer",
          authToken: "enc:secret-one",
          allowWrites: false,
          toolAllowlist: [],
          enabled: true,
        },
      ],
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

      expect(describeSettingsChanges({ pm }, { pm: next })).toEqual([
        "PM scheduled review: off → on",
        "PM first review at: 9 → 7",
      ]);
    });

    it("names MCP servers and their changes without their credentials", () => {
      const next = {
        ...pm,
        mcpServers: [
          { ...pm.mcpServers[0], authToken: "enc:secret-two", allowWrites: true },
          { ...pm.mcpServers[0], name: "linear", authToken: "enc:secret-three" },
        ],
      };

      const lines = describeSettingsChanges({ pm }, { pm: next });

      expect(lines).toEqual([
        "PM MCP servers: github → github, linear",
        "PM MCP server github · Allow writes: off → on",
        "PM MCP server github · Token replaced",
      ]);
      expect(lines.join("\n")).not.toMatch(/secret/);
    });

    it("names links by label and address", () => {
      expect(describeSettingsChanges({ pm }, { pm: { ...pm, links: [] } })).toEqual([
        "PM links: Docs (https://docs.example) → none",
      ]);
    });

    it("reads a project that never had a PM block as starting from the defaults", () => {
      expect(describeSettingsChanges({}, { pm: { ...pm, mcpServers: [], links: [] } })).toEqual([
        "PM agent: off → on",
        "PM model: none → kimi",
      ]);
    });

    it("names what a zero cap means rather than printing the zero", () => {
      expect(
        describeSettingsChanges({ pm }, { pm: { ...pm, dailyTurnCap: 50, dailyTokenCap: 200_000 } })
      ).toEqual([
        "PM turns per day: server default → 50",
        "PM tokens per day: no ceiling → 200000",
      ]);
    });

    it("reads an instance admin's single-field change the same way", () => {
      expect(
        describeSettingsChanges({ pm: { dailyTurnCap: 40 } }, { "pm.dailyTurnCap": 0, "pm.enabled": true })
      ).toEqual(["PM turns per day: 40 → server default", "PM agent: off → on"]);
    });
  });

  it("shortens a long value rather than writing it whole", () => {
    const [line] = describeSettingsChanges({ description: "" }, { description: "x".repeat(500) });

    expect(line.length).toBeLessThan(120);
    expect(line.endsWith("…")).toBe(true);
  });
});
