import mongoose, { Schema, Model } from "mongoose";
import { IDeviceEnrolment } from "@/types";

const deviceEnrolmentSchema = new Schema<IDeviceEnrolment>(
  {
    deviceCodeHash: { type: String, required: true, unique: true, index: true },
    deviceCodePrefix: { type: String, required: true, index: true },
    userCode: { type: String, required: true, unique: true, index: true, uppercase: true },
    machineName: { type: String, required: true, trim: true },
    machineHost: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
    },
    enrolledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    worker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
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
