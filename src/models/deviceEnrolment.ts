import mongoose, { Schema, Model } from "mongoose";
import { IDeviceEnrolment } from "@/types";

// An enrolment in progress. The app holds the device code; the operator reads the user code off
// their own screen and approves it in a browser. Same shape as oauthCode — hashed secret, single
// use, a TTL index that reaps the abandoned ones.
const deviceEnrolmentSchema = new Schema<IDeviceEnrolment>(
  {
    // Hashed, because it is the app's half of the exchange and is what the credential is handed to
    deviceCodeHash: { type: String, required: true, unique: true, index: true },
    // Shown on both screens so a person can see they are approving the machine in front of them
    userCode: { type: String, required: true, unique: true, index: true, uppercase: true },
    machineName: { type: String, required: true, trim: true },
    machineHost: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    preset: { type: String, enum: ["write", "review", "merge"], default: "review" },
    worker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
    // Held only between approval and the app's next poll, then cleared. A credential sitting in a
    // row that outlives the exchange is a credential in a second place.
    credential: { type: String, default: "" },
    deliveredAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

deviceEnrolmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DeviceEnrolment: Model<IDeviceEnrolment> =
  mongoose.models.DeviceEnrolment ||
  mongoose.model<IDeviceEnrolment>("DeviceEnrolment", deviceEnrolmentSchema);
