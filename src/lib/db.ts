import mongoose from "mongoose";
import type { MongoClient } from "mongodb";
import { DatabaseUnavailableError, isDatabaseUnreachable } from "./db-errors";

export { DatabaseUnavailableError, isDatabaseUnreachable };

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  reportedAt: number | null;
  failedAt: number | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

const OUTAGE_LOG_INTERVAL_MS = 60_000;

const SERVER_SELECTION_TIMEOUT_MS = 5_000;

const FAILURE_COOLDOWN_MS = 1_000;

async function releaseAbandonedClient(client: MongoClient | undefined): Promise<void> {
  if (!client || client === mongoose.connection.getClient()) return;
  try {
    await client.close();
  } catch {
  }
}

function openConnection(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
}

export async function connectDB(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  const cached: MongooseCache = global.mongooseCache ?? {
    conn: null,
    promise: null,
    reportedAt: null,
    failedAt: null,
  };

  if (!global.mongooseCache) {
    global.mongooseCache = cached;
  }

  if (cached.conn && mongoose.connection.readyState === 0) {
    cached.conn = null;
    const abandoned = mongoose.connection.getClient();
    cached.promise = openConnection(uri).finally(() => releaseAbandonedClient(abandoned));
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (
    !cached.promise &&
    cached.failedAt !== null &&
    Date.now() - cached.failedAt < FAILURE_COOLDOWN_MS
  ) {
    throw new DatabaseUnavailableError(new Error("the database was unreachable a moment ago"));
  }

  if (!cached.promise) {
    cached.promise = openConnection(uri);
  }

  try {
    cached.conn = await cached.promise;
    cached.failedAt = null;
    if (cached.reportedAt !== null) {
      console.log("MongoDB is reachable again");
      cached.reportedAt = null;
    }
  } catch (err) {
    const unreachable = isDatabaseUnreachable(err);
    const detail = err instanceof Error ? err.message : err;

    if (!unreachable) {
      cached.promise = null;
      console.error("MongoDB refused the connection as configured:", detail);
      throw err;
    }

    cached.failedAt = Date.now();

    if (cached.reportedAt === null || Date.now() - cached.reportedAt >= OUTAGE_LOG_INTERVAL_MS) {
      cached.reportedAt = Date.now();
      console.error(
        "MongoDB is unreachable — requests needing it will answer 503 until it returns:",
        detail
      );
    }
    cached.promise = null;
    throw new DatabaseUnavailableError(err);
  }
  return cached.conn;
}
