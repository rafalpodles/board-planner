import mongoose, { Schema, Model } from "mongoose";
import { IPmMessage } from "@/types";

const pmMessageSchema = new Schema<IPmMessage>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    actions: {
      type: [{
        tool: { type: String, required: true },
        taskKey: { type: String },
        summary: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      }],
      default: [],
    },
    triggeredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

pmMessageSchema.index({ project: 1, createdAt: -1 });

export const PmMessage: Model<IPmMessage> =
  mongoose.models.PmMessage || mongoose.model<IPmMessage>("PmMessage", pmMessageSchema);
