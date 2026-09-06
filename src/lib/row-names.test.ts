import { describe, it, expect } from "vitest";
import { distinctRowNames } from "./row-names";
import { maskSecretUrl } from "./project-secrets";

describe("distinctRowNames", () => {
  it("leaves names that are already distinct alone", () => {
    expect(distinctRowNames(["alpha-room", "beta-room"])).toEqual(["alpha-room", "beta-room"]);
  });

  it("appends the position to every member of a collision, and only to them", () => {
    expect(distinctRowNames(["alerts", "builds", "alerts"])).toEqual([
      "alerts (1)",
      "builds",
      "alerts (3)",
    ]);
  });

  it("gives three of the same name three different names", () => {
    const named = distinctRowNames(["alerts", "alerts", "alerts"]);
    expect(new Set(named).size).toBe(3);
  });

  it("keeps an empty list empty and a single name bare", () => {
    expect(distinctRowNames([])).toEqual([]);
    expect(distinctRowNames(["only"])).toEqual(["only"]);
  });
});

/**
 * The reason webhooks need this at all: they carry no name, so the row is identified by the mask,
 * and the mask is lossy in a way that is easy to hit rather than contrived.
 */
describe("the webhook masks this exists for", () => {
  it("two different endpoints on one host can mask to the same string", () => {
    const a = maskSecretUrl("https://example.com/hooks/board");
    const b = maskSecretUrl("https://example.com/hooks/second-board");
    expect(a).toBe(b);

    expect(new Set(distinctRowNames([a, b])).size).toBe(2);
  });

  it("a path of four characters or fewer leaves nothing but the origin", () => {
    // The shape e2e/seed.ts already produces for `/ok`
    expect(maskSecretUrl("https://api.example.com/ok")).toBe(
      maskSecretUrl("https://api.example.com/no")
    );
  });
});
