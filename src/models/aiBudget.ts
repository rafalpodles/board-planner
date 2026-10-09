import mongoose, { Schema, Model, Types } from "mongoose";
import { withOrganisation } from "@/lib/organisation-field";

export const AI_BUDGET_KINDS = ["day", "month", "trial"] as const;
export type AiBudgetKind = (typeof AI_BUDGET_KINDS)[number];

export interface IAiBudget {
  _id: Types.ObjectId;
  kind: AiBudgetKind;
  /** `2026-10-09` for a day, `2026-10` for a month, `all` for a trial (it is not a calendar period) */
  period: string;
  /** Tokens spent on the operator's key, which is what the limits are made of */
  tokens: number;
  calls: number;
  /** Tokens and calls made on the organisation's own key: counted for the screen, never refused */
  ownTokens: number;
  ownCalls: number;
}

const aiBudgetSchema = new Schema<IAiBudget>({
  kind: { type: String, enum: AI_BUDGET_KINDS, required: true },
  period: { type: String, required: true },
  tokens: { type: Number, default: 0 },
  calls: { type: Number, default: 0 },
  ownTokens: { type: Number, default: 0 },
  ownCalls: { type: Number, default: 0 },
});

aiBudgetSchema.index({ kind: 1, period: 1, organisation: 1 }, { unique: true });

withOrganisation(aiBudgetSchema);

export const AiBudget: Model<IAiBudget> = mongoose.models.AiBudget || mongoose.model<IAiBudget>("AiBudget", aiBudgetSchema);
