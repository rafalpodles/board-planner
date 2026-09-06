import { describe, it, expect } from "vitest";
import { devices } from "@playwright/test";
import config from "../playwright.config";

describe("the viewport the e2e suite actually runs at", () => {
  const expected = devices["Desktop Chrome"].viewport;

  it("is the same for every project, and is the one the device brings", () => {
    expect(config.projects?.length).toBeGreaterThan(0);

    for (const project of config.projects ?? []) {
      expect(project.use?.viewport, `project "${project.name}" resolves to a different viewport`)
        .toEqual(expected);
    }
  });

  it("is not contradicted by a width at the config level", () => {
    expect(
      (config.use as { viewport?: unknown } | undefined)?.viewport,
      "a config-level viewport is dead — every project's device spread wins over it"
    ).toBeUndefined();
  });
});
