import mongoose, { Schema, Model } from "mongoose";

export interface ISettings {
  _id: mongoose.Types.ObjectId;
  aiModel: string;
}

const settingsSchema = new Schema<ISettings>({
  aiModel: {
    type: String,
    default: "gpt-4o-mini",
  },
});

export const Settings: Model<ISettings> =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);

export async function getSettings(): Promise<ISettings> {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }
  return settings;
}
