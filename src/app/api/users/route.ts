import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import {
  FULL_NAME_RULE,
  isValidFullName,
  isValidUsername,
  normaliseFullName,
  USERNAME_RULE,
} from "@/lib/identifiers";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser, MIN_PASSWORD_LENGTH, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { ProvenanceError, provenanceRefusal } from "@/lib/session";
import { withAdmin } from "@/lib/middleware";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { User } from "@/models/user";
import { IUser } from "@/types";

// Machines are excluded: worker identities are accounts, but not people to invite, permission or
// delete from here, and a team that connects five machines would otherwise have a user list that is
// half machines.
export const GET = withAdmin(async () => {
  await connectDB();
  const users = await User.find({ kind: { $ne: "machine" } }).sort({ createdAt: 1 });
  return NextResponse.json(users);
});

export async function POST(request: Request) {
  await connectDB();

  const read = await readJsonBody<{ username?: string; password?: string; fullName?: string; email?: string }>(
    request
  );
  if (!read.ok) return read.response;
  const body = read.value;
  const { username, password, fullName } = body;

  if (!username || !password || !fullName) {
    return NextResponse.json(
      { error: "username, password, and fullName are required" },
      { status: 400 }
    );
  }
  // Validate what will be stored, trim included — the schema trims, so checking the untrimmed
  // string refused names that would have been stored perfectly well. A username reaches a
  // notification title and from there a chat message, where its characters stop being
  // decoration (BP-401).
  const storedUsername = String(username).trim().toLowerCase();
  if (!isValidUsername(storedUsername)) {
    return NextResponse.json({ error: USERNAME_RULE }, { status: 400 });
  }
  // Same rule the account itself gets under Settings → Profile, and for the same sinks. The
  // truthiness check above passes a name of nothing but spaces, which the schema then trims to ""
  // and refuses as `required` — a 400 arriving as a 500 (BP-410).
  const storedFullName = normaliseFullName(String(fullName));
  if (!isValidFullName(storedFullName)) {
    return NextResponse.json({ error: FULL_NAME_RULE }, { status: 400 });
  }
  // Optional: an instance with no mail server has no use for it, and demanding one would mean
  // inventing addresses. The cost of leaving it out is stated on the form — that account cannot
  // recover its own password.
  if (body.email !== undefined && typeof body.email !== "string") {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: "That does not look like an email address" }, { status: 400 });
  }
  // The two places a password is chosen have to agree, or the shorter one is the one that matters
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  // Declared out here because the audit row below names who did this, and on the bootstrap path
  // that is nobody: the first account on an instance is made by whoever reaches the login screen.
  let authUser: IUser | null = null;

  if (isBootstrap) {
    const refusal = provenanceRefusal(request);
    if (refusal) return refusal;
  } else {
    try {
      authUser = await getAuthUser(request);
    } catch (e) {
      if (e instanceof ProvenanceError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      throw e;
    }
    if (!authUser || authUser.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Creating an account with a chosen password is how a machine credential escapes the
    // viaMachineCredential gates: make the user, promote it, sign in as it. Same refusal the five
    // gated endpoints make, for the same reason.
    if (authUser.viaMachineCredential) {
      return NextResponse.json(
        { error: "This action requires an interactive session" },
        { status: 403 }
      );
    }
  }

  const hashedPassword = await bcrypt.hash(password, PASSWORD_COST_FACTOR);

  try {
    const user = await User.create({
      username: storedUsername,
      password: hashedPassword,
      fullName: storedFullName,
      email,
      role: isBootstrap ? "admin" : "member",
    });
    // The account's own beginning, which nothing recorded: the log knew that somebody's display
    // name changed and not that the account existed. `target` is the username because this row has
    // to still name them after the account is gone.
    void logInstanceAudit({
      action: "user_created",
      user: authUser?._id ?? null,
      actorUsername: authUser?.username ?? "",
      target: user.username,
      detail: isBootstrap
        ? "the first account on this instance, made an administrator"
        : "member",
    });

    return NextResponse.json(user, { status: 201 });
  } catch (err: unknown) {
    const conflict = duplicateKeyField(err);
    if (conflict) {
      // Two unique indexes reach this line now. Saying "username" for an address already on
      // another account would send the admin to change the one field that was fine.
      return NextResponse.json(
        {
          error:
            conflict === "email"
              ? "That email is already on another account"
              : "Username already exists",
        },
        { status: 409 }
      );
    }
    throw err;
  }
}
