import mongoose, { Schema } from "mongoose";

export const DEFAULT_TENANT_ID = new mongoose.Types.ObjectId("000000000000000000000001");

export const currentTenantId = () => DEFAULT_TENANT_ID;

export function withTenant<S extends Schema>(schema: S): S {
  schema.add({
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      default: currentTenantId,
    },
  });
  return schema;
}
