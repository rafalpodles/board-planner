import { describe, it, expect } from "vitest";
import { devices } from "@playwright/test";
import config from "../playwright.config";

/**
 * BP-449: `playwright.config.ts` claimed a 1600x1000 viewport for four months and never ran at it.
 * Every project spreads `devices["Desktop Chrome"]`, and a project's `use` wins over the config's,
 * so the width written at the top level was dead — and the comment beside it described a board
 * nobody was testing.
 *
 * Asserted here rather than in a spec because it has to hold for *every* project, and a Playwright
 * test can only report the one it runs under.
 */
describe("the viewport the e2e suite actually runs at", () => {
  const expected = devices["Desktop Chrome"].viewport;

  it("is the same for every project, and is the one the device brings", () => {
    expect(config.projects?.length).toBeGreaterThan(0);

    for (const project of config.projects ?? []) {
      expect(project.use?.viewport, `project "${project.name}" resolves to a different viewport`)
        .toEqual(expected);
    }
  });

  // The dead setting is the defect: anything here is silently overridden by the device spread, so
  // a width written at this level is a claim the suite does not honour.
  it("is not contradicted by a width at the config level", () => {
    expect(
      (config.use as { viewport?: unknown } | undefined)?.viewport,
      "a config-level viewport is dead — every project's device spread wins over it"
    ).toBeUndefined();
  });
});
