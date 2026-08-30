import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { databaseUnavailable } from "@/lib/middleware";
import { User } from "@/models/user";

/**
 * Whether this instance has been claimed — that is, whether it has any user at all.
 *
 * The login page used to offer "First time? Create Account" unconditionally, so every visitor to a
 * populated instance was invited to fill in a username and a password and answered 403 by
 * `POST /api/users`: a path that existed only to end in a refusal, and a refusal that reads like a
 * fault rather than a rule (BP-268).
 *
 * Deliberately unauthenticated, and deliberately not a control. `POST /api/users` remains the whole
 * of the gate: it counts the users itself and refuses a second bootstrap whatever any client
 * believes. This exists so the page can stop offering the doomed path, which is a question about
 * what to render and not about what is allowed.
 *
 * It does tell an anonymous caller that the instance is unclaimed, and that is a small addition
 * rather than nothing: `/login` is statically prerendered and used to offer the path either way, so
 * the cheapest previous probe was a **write**. A GET answers it now, unlogged and unthrottled,
 * where `/api/auth/login` has `withLockout` and `/api/auth/forgot` throttles on its source key.
 * Left that way deliberately — `POST /api/users` remains the whole of the control, and the window
 * this discloses is named in the README rather than hidden — but it is a real difference and not
 * one to describe as none.
 */
export async function GET() {
  try {
    await connectDB();
    const users = await User.countDocuments();
    return NextResponse.json({ unclaimed: users === 0 });
  } catch (e) {
    // Unreachable is not "unclaimed": answering true here would offer to create the first
    // administrator on an instance that may already have one
    if (isDatabaseUnreachable(e)) return databaseUnavailable();
    throw e;
  }
}
