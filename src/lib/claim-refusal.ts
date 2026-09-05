import { ColumnRole, ROLE_LABELS } from "@/types";

const COST: Partial<Record<ColumnRole, string>> = {
  approved: "there is nowhere to take work from",
  active: "there is nowhere to move a task once it is taken",
};

/**
 * A board that cannot claim at all, as distinct from one with nothing to claim. Thrown rather than
 * returned as null, because null is what an empty queue answers — and for as long as both looked
 * the same, a worker on a board missing a load-bearing column sat idle with nothing anywhere
 * saying why (BP-512).
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
