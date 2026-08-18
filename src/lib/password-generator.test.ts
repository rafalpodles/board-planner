import { describe, it, expect } from "vitest";
import { generatePassword, GENERATED_PASSWORD_LENGTH } from "@/lib/password-generator";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";

describe("generatePassword", () => {
  it("returns the asked-for length even when bytes are rejected", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
    }
    expect(generatePassword(64)).toHaveLength(64);
  });

  it("clears the length the API demands", () => {
    expect(GENERATED_PASSWORD_LENGTH).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  // It gets read out loud, so the pairs that get misheard are not in it
  it("leaves out the characters that are misheard or mistyped", () => {
    const many = Array.from({ length: 200 }, () => generatePassword()).join("");

    expect(many).not.toMatch(/[Il1O0]/);
    expect(many).toMatch(/^[A-Za-z2-9]+$/);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword()));

    expect(seen.size).toBe(100);
  });

  // A modulo over 56 values would make the first 32 letters of the alphabet twice as likely
  it("spreads across the whole alphabet", () => {
    const counts = new Map<string, number>();
    for (const ch of Array.from({ length: 400 }, () => generatePassword()).join("")) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }

    expect(counts.size).toBe(56);
    const frequencies = [...counts.values()];
    expect(Math.max(...frequencies) / Math.min(...frequencies)).toBeLessThan(1.8);
  });
});
