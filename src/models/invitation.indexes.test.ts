import { describe, it, expect } from "vitest";
import { Invitation } from "./invitation";

const NINETY_DAYS = 90 * 24 * 60 * 60;

describe("the Invitation TTL indexes (BP-947)", () => {
  const ttl = Invitation.schema
    .indexes()
    .filter(([, options]) => options?.expireAfterSeconds !== undefined)
    .map(([fields, options]) => ({ field: Object.keys(fields).join(","), after: options!.expireAfterSeconds, when: options!.partialFilterExpression }));

  it("delete an accepted, a revoked and a lapsed pending invitation 90 days on, each from its own moment", () => {
    expect(ttl).toEqual(
      expect.arrayContaining([
        { field: "expiresAt", after: NINETY_DAYS, when: { status: "pending" } },
        { field: "acceptedAt", after: NINETY_DAYS, when: { status: "accepted" } },
        { field: "updatedAt", after: NINETY_DAYS, when: { status: "revoked" } },
      ])
    );
    expect(ttl).toHaveLength(3);
  });

  it("keep the revoking write's time in updatedAt, which a TTL needs a schema to stamp", () => {
    expect(Invitation.schema.get("timestamps")).toBe(true);
  });
});
