import mongoose, { Schema, Model, type UpdateQuery } from "mongoose";
import { duplicateKeyField } from "@/lib/mongo-errors";
import type { ScopedDb } from "@/lib/db-scope";
import { withOrganisation } from "@/lib/organisation-field";

export interface ISettings {
  _id: mongoose.Types.ObjectId;
  aiModel: string;
  pmDefaultModel: string;
  pmDefaultDailyTurnCap: number;
  signUpDomains: string[];
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
  signUpDomains: {
    type: [String],
    default: [],
  },
});

withOrganisation(settingsSchema);
settingsSchema.index({ organisation: 1 }, { unique: true });

export const Settings: Model<ISettings> =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);

export async function updateSettings(db: ScopedDb, update: UpdateQuery<ISettings>): Promise<ISettings> {
  const write = () =>
    db.Settings.findOneAndUpdate({}, update, { upsert: true, returnDocument: "after" }) as Promise<ISettings>;
  try {
    return await write();
  } catch (err) {
    if (duplicateKeyField(err) !== "organisation") throw err;
    return write();
  }
}

export async function getSettings(db: ScopedDb): Promise<ISettings> {
  return updateSettings(db, { $setOnInsert: { aiModel: "gpt-4o-mini" } });
}
