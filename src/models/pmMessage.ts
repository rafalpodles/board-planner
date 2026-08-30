import mongoose, { Schema, Model } from "mongoose";
import { IPmMessage, PmMessageTrigger, PM_TRIGGER_TYPES } from "@/types";

// Separate schema: an inline subdocument with a field named "type" collides with Mongoose's typeKey
const triggerSchema = new Schema<PmMessageTrigger>(
  {
    type: { type: String, enum: PM_TRIGGER_TYPES, default: "chat" },
    taskKey: { type: String, default: "" },
  },
  { _id: false }
);

const pmMessageSchema = new Schema<IPmMessage>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    /**
     * What this turn cost, summed over its round-trips. A turn is up to MAX_STEPS calls, so the
     * turn cap alone says nothing about spend (BP-284). Stored on the message rather than counted
     * into the project, so the day's total is derived the same way the turn count already is —
     * from documents that exist anyway, with no accumulator to drift.
     */
    usage: {
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      /** Round-trips to the model. The number the turn cap was mistaken for. */
      calls: { type: Number, default: 0 },
      /** True when the turn stopped because it ran out of steps, not because it was finished */
      hitStepLimit: { type: Boolean, default: false },
    },
    actions: {
      type: [{
        tool: { type: String, required: true },
        taskKey: { type: String },
        summary: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      }],
      default: [],
    },
    attachments: {
      type: [{
        fileId: { type: String, required: true },
        mimeType: { type: String, required: true },
        width: { type: Number },
        height: { type: Number },
        bytes: { type: Number },
      }],
      default: [],
    },
    trigger: {
      type: triggerSchema,
      default: () => ({ type: "chat", taskKey: "" }),
    },
    triggeredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

pmMessageSchema.index({ project: 1, createdAt: -1 });
// Threads are read per user, newest first, with _id as the paging cursor
pmMessageSchema.index({ project: 1, triggeredBy: 1, _id: -1 });

export const PmMessage: Model<IPmMessage> =
  mongoose.models.PmMessage || mongoose.model<IPmMessage>("PmMessage", pmMessageSchema);
