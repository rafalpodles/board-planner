import { describe, it, expect } from "vitest";
import { formatFileSize, formatStorage } from "./storage-size";

const MB = 1024 * 1024;

describe("formatStorage", () => {
  it("counts in megabytes below a gigabyte and rounds a partial one up", () => {
    expect(formatStorage(0)).toBe("0 MB");
    expect(formatStorage(1)).toBe("1 MB");
    expect(formatStorage(300 * MB)).toBe("300 MB");
    expect(formatStorage(1023 * MB + 1)).toBe("1 GB");
  });

  it("counts in gigabytes from 1024 MB, with one decimal only where it is not whole", () => {
    expect(formatStorage(1024 * MB)).toBe("1 GB");
    expect(formatStorage(1229 * MB)).toBe("1.2 GB");
    expect(formatStorage(20480 * MB)).toBe("20 GB");
  });
});

describe("formatFileSize (BP-1025)", () => {
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

  it("never prints a number that is a whole unit under the smaller one's name", () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1 MB");
    expect(formatFileSize(1024 * MB - 1)).toBe("1 GB");
    expect(formatFileSize(1023.4 * 1024)).toBe("1023 KB");
  });
});
