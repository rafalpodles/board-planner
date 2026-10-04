import { describe, it, expect, vi, beforeEach } from "vitest";

let stored: string[] | undefined = [];
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/settings", () => ({ getSettings: async () => ({ signUpDomains: stored }) }));
const db = {} as never;

const { parseSignUpDomains, signUpOpenTo, MAX_SIGN_UP_DOMAINS } = await import("./sign-up-domains");

describe("parsing the allowed domains", () => {
  it("keeps them lower-cased, trimmed, without an @ and without repeats", () => {
    expect(parseSignUpDomains([" Corp.Example ", "@corp.example", "xn--bcher-kva.example", ""])).toEqual({
      ok: true,
      value: ["corp.example", "xn--bcher-kva.example"],
    });
  });

  it.each([["corp"], ["*.corp.example"], ["corp.example/path"], ["ada@corp.example"], ["-corp.example"]])(
    "refuses %s, which is not a domain name",
    (domain) => {
      const parsed = parseSignUpDomains([domain]);
      expect(parsed.ok).toBe(false);
    }
  );

  it("refuses anything but a list of strings", () => {
    expect(parseSignUpDomains("corp.example").ok).toBe(false);
    expect(parseSignUpDomains([42]).ok).toBe(false);
  });

  it(`takes at most ${MAX_SIGN_UP_DOMAINS}`, () => {
    const many = Array.from({ length: MAX_SIGN_UP_DOMAINS + 1 }, (_, i) => `d${i}.example`);
    expect(parseSignUpDomains(many).ok).toBe(false);
    expect(parseSignUpDomains(many.slice(1)).ok).toBe(true);
  });
});

describe("whether sign-up is open to an address", () => {
  beforeEach(() => {
    stored = ["corp.example"];
  });

  it("opens to exactly a listed domain, in any case", async () => {
    expect(await signUpOpenTo(db, "ada@corp.example")).toBe(true);
    expect(await signUpOpenTo(db, "ada@CORP.example")).toBe(true);
  });

  it("opens to none of its subdomains, and no lookalike", async () => {
    expect(await signUpOpenTo(db, "ada@eu.corp.example")).toBe(false);
    expect(await signUpOpenTo(db, "ada@evilcorp.example")).toBe(false);
    expect(await signUpOpenTo(db, "ada@corp.example.evil")).toBe(false);
  });

  it("is closed while nothing is listed", async () => {
    stored = undefined;
    expect(await signUpOpenTo(db, "ada@corp.example")).toBe(false);
  });
});
