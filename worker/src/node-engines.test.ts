import { describe, expect, it } from "vitest";
import { firstOnPath, satisfiesNodeRange } from "./node-engines.js";

describe("satisfiesNodeRange", () => {
  const cases: Array<[string, string, boolean]> = [
    ["26.8.1", ">=26", true],
    ["22.22.1", ">=26", false],
    ["26.0.0", ">=26", true],
    ["25.9.9", ">=26", false],
    ["22.12.0", "^22.12", true],
    ["22.11.9", "^22.12", false],
    ["23.0.0", "^22.12", false],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["20.1.9", "~20.1.0", true],
    ["20.2.0", "~20.1.0", false],
    ["22.5.0", "22.x", true],
    ["23.0.0", "22.x", false],
    ["22.5.1", "22.5", true],
    ["22.6.0", "22.5", false],
    ["22.5.1", "22.5.1", true],
    ["22.5.2", "22.5.1", false],
    ["21.0.0", ">=20 <23", true],
    ["23.0.0", ">=20 <23", false],
    ["18.0.0", "^20 || ^22", false],
    ["22.1.0", "^20 || ^22", true],
    ["20.9.0", "^20 || ^22", true],
    ["22.1.0", ">22", false],
    ["23.0.0", ">22", true],
    ["22.9.0", "<=22", true],
    ["23.0.0", "<=22", false],
    ["22.9.0", "<23.0.0", true],
    ["1.2.3", "*", true],
  ];

  it.each(cases)("%s against %s is %s", (version, range, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });

  it("reads a leading v on the version, which is how `node --version` prints it", () => {
    expect(satisfiesNodeRange("v26.8.1", ">=26")).toBe(true);
  });

  it("says null for a range it cannot read rather than guessing", () => {
    expect(satisfiesNodeRange("26.0.0", "1.2.3 - 2.3.4")).toBeNull();
    expect(satisfiesNodeRange("26.0.0", ">=lts")).toBeNull();
    expect(satisfiesNodeRange("26.0.0", "^26.0.0-beta.1")).toBeNull();
    expect(satisfiesNodeRange("not a version", ">=26")).toBeNull();
  });
});

describe("firstOnPath", () => {
  it("returns the first directory that holds an executable, in PATH order", () => {
    const executable = new Set(["/nvm/22/bin/node", "/opt/homebrew/bin/node"]);

    expect(firstOnPath("node", "/usr/bin:/nvm/22/bin:/opt/homebrew/bin", (p) => executable.has(p))).toBe("/nvm/22/bin/node");
    expect(firstOnPath("node", "/opt/homebrew/bin:/nvm/22/bin", (p) => executable.has(p))).toBe("/opt/homebrew/bin/node");
  });

  it("is null when nothing on the PATH has one, and ignores empty entries", () => {
    expect(firstOnPath("node", "::/usr/bin:", () => false)).toBeNull();
    expect(firstOnPath("node", "", () => true)).toBeNull();
  });
});
