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

  it("never produces two rows with the same name, whatever the input contains", () => {
    const adversarial = [
      ["alerts", "alerts", "alerts (2)"],
      ["x (3)", "x", "x", "x"],
      ["a", "a", "a (1)", "a (2)", "a (3)"],
      ["dup", "dup", "dup", "dup"],
    ];
    for (const names of adversarial) {
      const result = distinctRowNames(names);
      expect(result, JSON.stringify(names)).toHaveLength(new Set(result).size);
    }
  });
});

describe("the webhook masks this exists for", () => {
  it("two different endpoints on one host can mask to the same string", () => {
    const a = maskSecretUrl("https://example.com/hooks/board");
    const b = maskSecretUrl("https://example.com/hooks/second-board");
    expect(a).toBe(b);

    expect(new Set(distinctRowNames([a, b])).size).toBe(2);
  });

  it("a path of four characters or fewer leaves nothing but the origin", () => {
    expect(maskSecretUrl("https://api.example.com/ok")).toBe(
      maskSecretUrl("https://api.example.com/no")
    );
  });
});
