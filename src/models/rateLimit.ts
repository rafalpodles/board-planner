import mongoose, { Schema, Model } from "mongoose";

export interface IRateLimit {
  _id: string;
  count: number;
  resetAt: Date;
}

/**
 * The throttle counters, in the database rather than a module-scope Map.
 *
 * Three reasons, all of them properties the Map could not have: the counters survive a deploy
 * (Railway redeploys from `main`, which used to hand every attacker a clean budget), they are one
 * budget across replicas rather than one per replica, and Mongo's TTL reaper bounds the collection
 * without the process having to trust that every key it was asked about was a real one — which is
 * what let an anonymous caller grow the Map a key at a time (BP-318).
 *
 * `_id` is the throttle key itself, so a bump is one atomic upsert with no second lookup. The login
 * path already requires the database, so this adds no failure mode it did not have.
 */
const rateLimitSchema = new Schema<IRateLimit>({
  _id: { type: String },
  count: { type: Number, required: true, default: 0 },
  resetAt: { type: Date, required: true },
});

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit: Model<IRateLimit> =
  mongoose.models.RateLimit || mongoose.model<IRateLimit>("RateLimit", rateLimitSchema);
