import mongoose, { Schema } from "mongoose";

export const DEFAULT_ORGANISATION_ID = new mongoose.Types.ObjectId("000000000000000000000001");

export function withOrganisation<S extends Schema>(schema: S): S {
  schema.add({
    organisation: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      immutable: true,
    },
  });
  return schema;
}
