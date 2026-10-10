import { describe, it, expect } from "vitest";
import { PmMessage } from "./pmMessage";

// BP-647: Settings counts an organisation's PM turns in a month with no project in the filter, which the per-project indexes cannot serve
describe("the PmMessage indexes", () => {
  it("serve an organisation's turns by role and time, so a month's count is not a scan of every organisation's messages", () => {
    const keys = PmMessage.schema.indexes().map(([fields]) => Object.keys(fields).join(","));

    expect(keys).toContain("organisation,role,createdAt");
  });
});
