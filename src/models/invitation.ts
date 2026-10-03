import mongoose, { Schema, Model } from "mongoose";
import { GRANT_RELATIONS, IInvitation, INVITATION_STATUSES } from "@/types";
import { withTenant } from "@/lib/tenant-field";

const invitationSchema = new Schema<IInvitation>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    boards: {
      type: [
        {
          project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
          relation: { type: String, enum: GRANT_RELATIONS, required: true },
          addedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        },
      ],
      default: [],
      _id: false,
    },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: INVITATION_STATUSES, default: "pending" },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    acceptedAt: { type: Date, default: null },
    // Who holds the current link: the invited mailbox, or whoever was shown it. Null until known.
    deliveredAs: { type: String, enum: ["email", "link"], default: null },
  },
  { timestamps: true }
);

invitationSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);
invitationSchema.index(
  { email: 1, tenant: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

withTenant(invitationSchema);

export const Invitation: Model<IInvitation> =
  mongoose.models.Invitation || mongoose.model<IInvitation>("Invitation", invitationSchema);

if (!mongoose.models.Invitation || Invitation.listenerCount("index") === 0) {
  Invitation.on("index", (err: Error | undefined) => {
    if (err) console.error("Failed to build an index on invitations:", err.message);
  });
}
