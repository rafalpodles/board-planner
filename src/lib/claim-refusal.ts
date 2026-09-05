import { ColumnRole, ROLE_LABELS } from "@/types";

// The four roles a run needs, from the claim to the delivery, and what each one's absence costs
const COST: Partial<Record<ColumnRole, string>> = {
  approved: "there is nowhere to take work from",
  active: "there is nowhere to move a task once it is taken",
  review: "there is nowhere to put a run's result for a person to check",
  done: "there is nowhere to deliver finished work",
};

export const ROLES_A_RUN_NEEDS = ["approved", "active", "review", "done"] as const;

/**
 * A board that cannot claim at all, as distinct from one with nothing to claim. Thrown rather than
 * returned as null, because null is what an empty queue answers — and for as long as both looked
 * the same, a worker on a board missing a load-bearing column sat idle with nothing anywhere
 * saying why (BP-512).
 *
 * Refused at the claim for every role the run will need, not only the two the claim itself
 * writes: a task claimed onto a board with no review or done column was handed back at run start
 * with the attempt refunded, and claimed again on the very next pass, without a poll interval —
 * a comment on the task every iteration, for ever.
 */
export class BoardCannotClaim extends Error {
  constructor(readonly role: ColumnRole) {
    super(
      `This board has no column meaning ${ROLE_LABELS[role].label}, so ` +
        `${COST[role] ?? "a worker cannot run on it"}. Give a column that role in Settings → Board.`
    );
    this.name = "BoardCannotClaim";
  }
}
