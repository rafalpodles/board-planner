// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

/**
 * Node 26 defines localStorage on globalThis and reads it as undefined without
 * --localstorage-file, and vitest's happy-dom environment leaves globals it did not create alone —
 * so the DOM's own Storage never lands. 138 tests across 8 files failed the moment a machine ran
 * the suite on 26, which is how BP-432's worker came to fail its gate on every task it took.
 *
 * vitest.setup.ts repairs localStorage. sessionStorage is asserted alongside as a control: Node's
 * is in-memory and needs no repair today, so that case passes on every runtime and reports the day
 * one of them changes.
 */

describe.each(["localStorage", "sessionStorage"] as const)("%s in a DOM environment", (name) => {
  it("is a working Storage, whichever Node runs the suite", () => {
    const storage = globalThis[name];
    expect(storage).toBeTruthy();

    storage.setItem("bp-436", "value");
    expect(storage.getItem("bp-436")).toBe("value");
    expect(Object.keys(storage)).toContain("bp-436");

    storage.clear();
    expect(storage.length).toBe(0);
  });
});
