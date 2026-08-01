import { describe, it, expect } from "vitest";
import { Worker } from "./worker";

describe("Worker schema", () => {
  // The schema is the one place this is enforced for every consumer, including
  // ones that call findById directly and never heard of verifyWorkerCredential
  it("excludes credentialHash from a plain query by default", () => {
    expect(Worker.schema.path("credentialHash").options.select).toBe(false);
  });
});
