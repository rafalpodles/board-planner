import { it, expect } from "vitest";

it("fails on purpose to prove the CI passed gate blocks a merge (BP-821, never merged)", () => {
  expect(1).toBe(2);
});
