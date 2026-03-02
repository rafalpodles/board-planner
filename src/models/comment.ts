import mongoose, { Schema, Model } from "mongoose";
import { IComment } from "@/types";

const commentSchema = new Schema<IComment>({
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
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

commentSchema.index({ task: 1, createdAt: 1 });

export const Comment: Model<IComment> =
  mongoose.models.Comment ||
  mongoose.model<IComment>("Comment", commentSchema);
