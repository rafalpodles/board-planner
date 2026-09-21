import mongoose, { Model, UpdateQuery } from "mongoose";
import { duplicateKeyField } from "./mongo-errors";

// The filter stays `{}` so an instance's existing document, inserted with a random _id, is still
// the one every read finds.
export const SINGLETON_ID = new mongoose.Types.ObjectId("000000000000000000000001");

export async function upsertSingleton<T>(model: Model<T>, update: UpdateQuery<T>): Promise<T> {
  const withFixedId = {
    ...update,
    $setOnInsert: { ...(update.$setOnInsert ?? {}), _id: SINGLETON_ID },
  } as UpdateQuery<T>;
  const write = () =>
    model.findOneAndUpdate({}, withFixedId, { upsert: true, returnDocument: "after" }) as Promise<T>;

  try {
    return await write();
  } catch (err) {
    // Two first writes both found nothing and both inserted; the loser now matches the winner
    if (duplicateKeyField(err) !== "_id") throw err;
    return write();
  }
}
