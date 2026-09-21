import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import { Notification } from "./notification";

const row = (extra: Record<string, unknown> = {}) =>
  new Notification({
    recipient: new Types.ObjectId(),
    type: "board_access",
    project: new Types.ObjectId(),
    actor: new Types.ObjectId(),
    title: "Olga added you to Orbit as a member",
    ...extra,
  });

// BP-753: board_access is about a board, and a required task made every one of them fail to save
describe("Notification schema", () => {
  it("accepts a row that names no task", () => {
    expect(row().validateSync()).toBeUndefined();
  });

  it("still requires the board it belongs to", () => {
    expect(row({ project: undefined }).validateSync()?.errors.project).toBeDefined();
  });
});
