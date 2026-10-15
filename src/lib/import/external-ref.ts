import { Schema } from "mongoose";
import type { ExternalRef } from "@/types";
import { EXTERNAL_ID_MAX_LENGTH, EXTERNAL_SOURCE_MAX_LENGTH } from "./limits";


export const externalRefSchema = new Schema<ExternalRef>(
  {
    source: { type: String, required: true, maxlength: EXTERNAL_SOURCE_MAX_LENGTH },
    id: { type: String, required: true, maxlength: EXTERNAL_ID_MAX_LENGTH },
  },
  { _id: false }
);
