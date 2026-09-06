import { describe, it, expect } from "vitest";
import { Worker } from "./worker";

describe("Worker schema", () => {
  it("excludes credentialHash from a plain query by default", () => {
    expect(Worker.schema.path("credentialHash").options.select).toBe(false);
  });
});
