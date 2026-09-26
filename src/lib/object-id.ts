import { Types } from "mongoose";

// BSON hex is read case-insensitively and a stored id prints in lower case, so an id from a request
// is compared with stored ones only in this spelling
export function canonicalObjectId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value)
    ? new Types.ObjectId(value).toString()
    : null;
}
