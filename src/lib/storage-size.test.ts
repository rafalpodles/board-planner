import { describe, it, expect } from "vitest";
import { formatFileSize, formatStorage } from "./storage-size";

const MB = 1024 * 1024;

describe("what a size reads as (BP-1025)", () => {
  it("shows a small file as it is, where a total rounds up so that it never reads below what is used", () => {
    expect(formatFileSize(70)).toBe("70 B");
    expect(formatFileSize(1536)).toBe("2 KB");
    expect(formatFileSize(410_000)).toBe("400 KB");
    expect(formatStorage(70)).toBe("1 MB");
  });

  it("goes up by units, with one decimal from a megabyte", () => {
    expect(formatFileSize(2.6 * MB)).toBe("2.6 MB");
    expect(formatFileSize(5 * MB)).toBe("5 MB");
    expect(formatFileSize(1536 * MB)).toBe("1.5 GB");
  });
});
