import { ColumnRole, ROLE_LABELS } from "@/types";

const COST: Partial<Record<ColumnRole, string>> = {
  approved: "there is nowhere to take work from",
  active: "there is nowhere to move a task once it is taken",
  review: "there is nowhere to put a run's result for a person to check",
  done: "there is nowhere to deliver finished work",
};

export const ROLES_A_RUN_NEEDS = ["approved", "active", "review", "done"] as const;

export class BoardCannotClaim extends Error {
  constructor(readonly role: ColumnRole) {
    super(
      `This board has no column meaning ${ROLE_LABELS[role].label}, so ` +
        `${COST[role] ?? "a worker cannot run on it"}. Give a column that role in Settings → Board.`
    );
    this.name = "BoardCannotClaim";
  }
}
