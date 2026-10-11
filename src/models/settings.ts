import mongoose, { Schema, Model, type UpdateQuery } from "mongoose";
import { duplicateKeyField } from "@/lib/mongo-errors";
import type { ScopedDb } from "@/lib/db-scope";
import { withOrganisation } from "@/lib/organisation-field";
import { DEFAULT_AI_MODEL } from "@/lib/ai-model";

export interface ISettings {
  _id: mongoose.Types.ObjectId;
  aiModel: string;
  signUpDomains: string[];
  openrouterKey?: string;
  openrouterKeyHint?: string;
  // The organisation's own OpenID Connect provider (BP-951); the secret is sealed under the organisation's key
  sso?: { issuer: string; clientId: string; clientSecret: string; clientSecretHint: string; label: string; enforced?: boolean };
  // The trial end the admins were last told single sign-on stops at, so a trial is told once (BP-951)
  ssoTrialNoticeFor?: Date | null;
  // Shared providers (google, github) this organisation's administrators turned off for it; absent means every one is offered (BP-1027)
  disabledProviders?: string[];
}

const settingsSchema = new Schema<ISettings>({
  aiModel: {
    type: String,
    default: DEFAULT_AI_MODEL,
  },
  signUpDomains: {
    type: [String],
    default: [],
  },
  openrouterKey: { type: String },
  openrouterKeyHint: { type: String },
  sso: {
    type: new Schema(
      {
        issuer: { type: String, required: true, maxlength: 300 },
        clientId: { type: String, required: true, maxlength: 300 },
        clientSecret: { type: String, required: true },
        clientSecretHint: { type: String, default: "" },
        label: { type: String, default: "Single sign-on", maxlength: 40 },
        enforced: { type: Boolean, default: false },
      },
      { _id: false }
    ),
    default: undefined,
  },
  ssoTrialNoticeFor: { type: Date, default: null },
  disabledProviders: { type: [String], default: undefined },
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
  return updateSettings(db, { $setOnInsert: { aiModel: DEFAULT_AI_MODEL } });
}
