import mongoose, { Model, UpdateQuery } from "mongoose";
import { duplicateKeyField } from "./mongo-errors";

export const SINGLETON_ID = new mongoose.Types.ObjectId("000000000000000000000001");

export async function upsertSingleton<T>(model: Model<T>, update: UpdateQuery<T>): Promise<T> {
  const withFixedId = {
    ...update,
    $setOnInsert: { ...(update.$setOnInsert ?? {}), _id: SINGLETON_ID },
  } as UpdateQuery<T>;
  // `{}`, not the fixed id: an instance's existing document was inserted under a random one
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
