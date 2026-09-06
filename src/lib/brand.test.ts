import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./brand";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_NAME = new RegExp(["cla", "ude", " ?-? ?", "plan", "ner"].join(""), "i");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("the name this product used to have", () => {
  it("appears nowhere in the source", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => ({ file: relative(SRC, file), text: readFileSync(file, "utf8") }))
      .filter(({ text }) => OLD_NAME.test(text))
      .map(({ file }) => file);

    expect(offenders, "use APP_NAME from @/lib/brand").toEqual([]);
  });

  it("is not what the product calls itself", () => {
    expect(OLD_NAME.test(APP_NAME)).toBe(false);
  });
});
