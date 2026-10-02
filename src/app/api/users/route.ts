import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser, getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { setupCodeIsConfigured, setupCodeMatches } from "@/lib/setup-code";
import { checkNewAccount } from "@/lib/new-account";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { ProvenanceError, provenanceRefusal } from "@/lib/session";
import { withAdmin } from "@/lib/middleware";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { revokePendingInvitationsFor } from "@/lib/invitations";
import { User } from "@/models/user";
import { IUser } from "@/types";

// Machines are excluded: worker identities are accounts, but not people to invite, permission or
// delete from here, and a team that connects five machines would otherwise have a user list that is
// half machines. `?include=machines` opts them in (BP-718).
export const GET = withAdmin(async (request) => {
  await connectDB();
  const includeMachines = new URL(request.url).searchParams.get("include") === "machines";
  const users = await User.find(includeMachines ? {} : { kind: { $ne: "machine" } }).sort({
    createdAt: 1,
  });
  return NextResponse.json(users);
});

export async function POST(request: Request) {
  await connectDB();

  const read = await readJsonBody<{
    username?: string;
    password?: string;
    fullName?: string;
    email?: string;
    setupCode?: string;
  }>(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const checked = checkNewAccount(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const { username: storedUsername, fullName: storedFullName, email, password } = checked.value;

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  // Declared out here because the audit row below names who did this, and on the bootstrap path
  // that is nobody: the first account on an instance is made by whoever reaches the login screen.
  let authUser: IUser | null = null;

  if (isBootstrap) {
    const refusal = provenanceRefusal(request);
    if (refusal) return refusal;
    // A configured token is throttled before it is compared; a generated code is checked first, so a
    // stranger filling the shared bucket cannot lock the operator out of an unguessable one
    const clientIp = getClientIp(request);
    const throttleKey = sourceKey(clientIp ?? "-", "bootstrap");
    const throttled = () => isRateLimited(throttleKey, anonymousMultiplier(clientIp, 10));
    const tooMany = () =>
      NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    if (setupCodeIsConfigured() && (await throttled())) return tooMany();
    if (!setupCodeMatches(body.setupCode)) {
      if (await throttled()) return tooMany();
      await recordFailedAttempt(throttleKey);
      return NextResponse.json({ error: "The setup code is missing or wrong." }, { status: 403 });
    }
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
    await revokePendingInvitationsFor(email);
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
        : "a member",
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
