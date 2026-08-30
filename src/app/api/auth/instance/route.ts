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
 * It tells an anonymous caller that the instance is unclaimed. That is the same fact the old page
 * published by offering the path, and the same one a single POST already established, so it adds
 * no reach — but it is a fact worth stating plainly in the install docs rather than leaving for
 * somebody to discover.
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
