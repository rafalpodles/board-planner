import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

export async function connectDB(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  const cached: MongooseCache = global.mongooseCache ?? {
    conn: null,
    promise: null,
  };

  if (!global.mongooseCache) {
    global.mongooseCache = cached;
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(uri);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
