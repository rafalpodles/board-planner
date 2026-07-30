import mongoose, { Schema, Model } from "mongoose";

export interface ISettings {
  _id: mongoose.Types.ObjectId;
  aiModel: string;
  pmDefaultModel: string;
  pmDefaultDailyTurnCap: number;
}

const settingsSchema = new Schema<ISettings>({
  aiModel: {
    type: String,
    default: "gpt-4o-mini",
  },
  pmDefaultModel: {
    type: String,
    default: "",
  },
  pmDefaultDailyTurnCap: {
    type: Number,
    default: 0,
  },
});

export const Settings: Model<ISettings> =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);

export async function getSettings(): Promise<ISettings> {
  return Settings.findOneAndUpdate(
    {},
    { $setOnInsert: { aiModel: "gpt-4o-mini" } },
    { upsert: true, returnDocument: "after" }
  ) as Promise<ISettings>;
}
