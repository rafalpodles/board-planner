import { Types } from "mongoose";
import { isObjectIdSegment } from "@/lib/urls";

// BSON hex is read case-insensitively and a stored id prints in lower case, so an id from a request
// is compared with stored ones only in this spelling
export function canonicalObjectId(value: unknown): string | null {
  return typeof value === "string" && isObjectIdSegment(value) ? new Types.ObjectId(value).toString() : null;
}
