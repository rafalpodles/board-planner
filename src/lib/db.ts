import mongoose from "mongoose";

/**
 * The database could not be reached — which is not the same as anything the caller did wrong.
 *
 * It exists so the auth middleware can tell "I cannot resolve this session" from "I resolved it and
 * it is not valid". Answering 401 for both told everyone their credential had gone bad during an
 * outage, and the browser client clears the session on a 401, so an outage signed people out
 * (BP-362).
 */
export class DatabaseUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "the database is unreachable");
    this.name = "DatabaseUnavailableError";
  }
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

let reportedUnavailable = false;

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

  // Reset cache if connection was lost
  if (cached.conn && mongoose.connection.readyState === 0) {
    cached.conn = null;
    cached.promise = null;
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(uri);
  }

  try {
    cached.conn = await cached.promise;
    if (reportedUnavailable) {
      console.log("MongoDB is reachable again");
      reportedUnavailable = false;
    }
  } catch (err) {
    // Once per outage, not once per request: every route calls this, so logging each failure buries
    // the cause under the symptom at exactly the moment somebody is reading the log to find it
    if (!reportedUnavailable) {
      reportedUnavailable = true;
      console.error(
        "MongoDB is unreachable — requests needing it will answer 503 until it returns:",
        err instanceof Error ? err.message : err
      );
    }
    // Drop the rejected promise, or it is the answer to every request from here on. The reset above
    // cannot do it: it needs `cached.conn`, which a connection that never succeeded does not have —
    // so one refused connection at boot used to make the instance permanently unable to reach a
    // database that had since come back, and only a redeploy fixed it. That is also what made
    // "route handlers reconnect lazily" untrue, which is the reason instrumentation.ts is allowed
    // to log a boot-time failure and carry on (BP-362).
    cached.promise = null;
    throw new DatabaseUnavailableError(err);
  }
  return cached.conn;
}
