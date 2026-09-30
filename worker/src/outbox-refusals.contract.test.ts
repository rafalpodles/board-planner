import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_ASSIGNED } from "./outbox.js";

// The outbox narrows a hold to one project only on this exact answer, and any other 403 stops the
// whole flush, so a reworded refusal would quietly bring back BP-797 rather than fail anything.
const MIDDLEWARE = join(import.meta.dirname, "..", "..", "src", "lib", "middleware.ts");

describe("the refusal the outbox reads as one project's", () => {
  // Both sites: the run-record route's and the one every task route goes through
  it("is the 403 the board answers for a project that does not have this machine", () => {
    const source = readFileSync(MIDDLEWARE, "utf8").replace(/\s+/g, " ");
    const refusal = `{ error: "${NOT_ASSIGNED}" }, { status: 403 }`;
    expect(source.split(refusal).length - 1).toBe(2);
  });
});
