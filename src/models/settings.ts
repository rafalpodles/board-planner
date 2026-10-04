import mongoose, { Schema, Model, type UpdateQuery } from "mongoose";
import { upsertSingleton } from "@/lib/singleton";
import { DEFAULT_TENANT_ID, withTenant } from "@/lib/tenant-field";

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

withTenant(settingsSchema);

export const Settings: Model<ISettings> =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);

// TODO(BP-667): one Settings row per tenant
export function updateSettings(update: UpdateQuery<ISettings>): Promise<ISettings> {
  return upsertSingleton(Settings, {
    ...update,
    $setOnInsert: { ...(update.$setOnInsert ?? {}), tenant: DEFAULT_TENANT_ID },
  });
}

export async function getSettings(): Promise<ISettings> {
  return updateSettings({ $setOnInsert: { aiModel: "gpt-4o-mini" } });
}
