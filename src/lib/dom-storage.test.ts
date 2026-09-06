// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

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
