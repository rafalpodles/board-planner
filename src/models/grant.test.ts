import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import { Grant } from "./grant";

const row = { subject: new Types.ObjectId(), relation: "member", object: new Types.ObjectId(), organisation: new Types.ObjectId() };

describe("Grant.source (BP-861)", () => {
  it("is manual for a new grant that names none", () => {
    expect(new Grant(row).source).toBe("manual");
  });

  it("reads a stored grant older than the field as manual, with no migration", () => {
    expect(Grant.hydrate(row).source).toBe("manual");
  });

  it("keeps a group's grant as one", () => {
    expect(new Grant({ ...row, source: "idp" }).source).toBe("idp");
  });

  it("refuses any other source", () => {
    expect(new Grant({ ...row, source: "scim" }).validateSync()?.errors.source).toBeDefined();
  });
});
