import mongoose, { Schema, Model, Types } from "mongoose";
import { withOrganisation } from "@/lib/organisation-field";

export interface IHandoffCode {
  _id: Types.ObjectId;
  organisation: Types.ObjectId;
  codeHash: string;
  user: Types.ObjectId;
  expiresAt: Date;
  spentAt: Date | null;
  createdAt: Date;
}

const handoffCodeSchema = new Schema<IHandoffCode>(
  {
    codeHash: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    spentAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

handoffCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

withOrganisation(handoffCodeSchema);

export const HandoffCode: Model<IHandoffCode> =
  mongoose.models.HandoffCode || mongoose.model<IHandoffCode>("HandoffCode", handoffCodeSchema);
