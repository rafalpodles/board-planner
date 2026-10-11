import { describe, it, expect } from "vitest";
import { formatStorage } from "./storage-size";

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
