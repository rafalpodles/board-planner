import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getClientIp } from "@/lib/auth";
import type { ScopedDb } from "@/lib/db-scope";
import { passwordSignInEnabled } from "@/lib/password-sign-in";
import {
  clearAttempts,
  EXCLUSIVE_SOURCE_ATTEMPTS,
  lockoutKey,
  sourceKey,
  withLockout,
} from "@/lib/rate-limit";
import { RECENT_SIGN_IN_REQUIRED, signedInRecently } from "@/lib/session";

interface Asker {
  _id: unknown;
  username: string;
  sessionId?: unknown;
}

/**
 * The proof an action that cannot be undone asks of the person doing it: their password where they
 * have one to give, and a sign-in made in the last few minutes where they do not. Null means proven.
 */
export async function confirmOwnAccount(
  db: ScopedDb,
  request: Request,
  user: Asker,
  purpose: string,
  currentPassword: unknown
): Promise<NextResponse | null> {
  const record = await db.User.findById(user._id).select("+password");
  if (!record) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (!passwordSignInEnabled() || !record.password) {
    if (await signedInRecently(user.sessionId)) return null;
    return NextResponse.json({ error: RECENT_SIGN_IN_REQUIRED }, { status: 403 });
  }

  if (typeof currentPassword !== "string" || !currentPassword) {
    return NextResponse.json({ error: "Your current password is required" }, { status: 400 });
  }
  const hash = record.password;
  const { lockedOut, result: matches } = await withLockout(
    lockoutKey(db.organisation, getClientIp(request) ?? "-", user.username, purpose),
    async () => ((await bcrypt.compare(currentPassword, hash)) ? true : null),
    sourceKey(String(user._id), purpose),
    EXCLUSIVE_SOURCE_ATTEMPTS
  );
  if (lockedOut) {
    return NextResponse.json({ error: "Too many failed attempts. Try again later." }, { status: 429 });
  }
  if (!matches) return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
  // The source key is the signed-in account itself, so a success refunds nobody else's budget
  await clearAttempts(sourceKey(String(user._id), purpose)).catch(() => {});
  return null;
}
