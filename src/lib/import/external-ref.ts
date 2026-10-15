import { Schema } from "mongoose";
import type { ExternalRef } from "@/types";

export const EXTERNAL_SOURCE_MAX_LENGTH = 50;
export const EXTERNAL_ID_MAX_LENGTH = 200;

export const externalRefSchema = new Schema<ExternalRef>(
  {
    source: { type: String, required: true, maxlength: EXTERNAL_SOURCE_MAX_LENGTH },
    id: { type: String, required: true, maxlength: EXTERNAL_ID_MAX_LENGTH },
  },
  { _id: false }
);
