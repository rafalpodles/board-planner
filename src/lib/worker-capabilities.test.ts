import { describe, it, expect } from "vitest";
import { capabilitiesOf, MULTI_REPOSITORY } from "./worker-capabilities";

const asking = (header?: string) =>
  new Request("http://x", { headers: header === undefined ? {} : { "x-cp-capabilities": header } });

describe("capabilitiesOf", () => {
  it("reads nothing from a request that says nothing, which is every worker that predates it", () => {
    expect(capabilitiesOf(asking())).toEqual([]);
    expect(capabilitiesOf(asking(""))).toEqual([]);
  });

  it("reads a named capability, in any case and with spaces", () => {
    expect(capabilitiesOf(asking("multi-repository"))).toEqual([MULTI_REPOSITORY]);
    expect(capabilitiesOf(asking(" Multi-Repository , other-thing "))).toEqual([MULTI_REPOSITORY, "other-thing"]);
  });

  it("drops what is not a capability name, repeats, and anything past sixteen", () => {
    expect(capabilitiesOf(asking("multi-repository, multi-repository, ../x, a b, 9x, "))).toEqual([MULTI_REPOSITORY]);
    const many = Array.from({ length: 40 }, (_, i) => `cap-${i}`).join(",");
    expect(capabilitiesOf(asking(many))).toHaveLength(16);
  });
});
