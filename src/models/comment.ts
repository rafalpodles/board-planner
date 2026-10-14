import mongoose, { Schema, Model } from "mongoose";
import { ACTIVITY_SOURCES, IComment } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";
import { generatedBySchema } from "@/lib/ai-generated";
import { SOURCE_DETAIL_MAX_LENGTH } from "@/lib/activity-source";

const reactionSchema = new Schema(
  {
    emoji: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false }
);

const commentSchema = new Schema<IComment>(
  {
    task: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    body: {
      type: String,
      required: true,
      // A backstop well above the route's cap, so a writer that forgets the cap is still bounded
      // and a comment stored before the cap still saves
      maxlength: 100_000,
    },
    reactions: {
      type: [reactionSchema],
      default: [],
    },
    generatedBy: { type: generatedBySchema, default: undefined },
    source: { type: String, enum: ACTIVITY_SOURCES, immutable: true },
    sourceDetail: { type: String, maxlength: SOURCE_DETAIL_MAX_LENGTH, immutable: true },
  },
  { timestamps: true }
);

commentSchema.index({ task: 1, createdAt: 1 });

withOrganisation(commentSchema);

export const Comment: Model<IComment> =
  mongoose.models.Comment ||
  mongoose.model<IComment>("Comment", commentSchema);
