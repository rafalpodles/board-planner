import { checkOrganisationName, nameOrganisation } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { passwordSignInEnabled } from "@/lib/password-sign-in";
import { readJsonBody } from "@/lib/request-body";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser, getClientIp, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { refuseSetupCode } from "@/lib/setup-code";
import { checkNewAccount } from "@/lib/new-account";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { ProvenanceError, provenanceRefusal } from "@/lib/session";
import { withAdmin } from "@/lib/middleware";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { revokePendingInvitationsFor } from "@/lib/invitations";
import { User } from "@/models/user";
import { Identity } from "@/models/identity";
import { Session } from "@/models/session";
import { liveIdentityFilter, providerById } from "@/lib/oidc/providers";
import { HydratedDocument } from "mongoose";
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
  return NextResponse.json(await withSignInMethods(users));
});

/**
 * How each account can sign in, for the Users screen: a password while passwords sign anybody in,
 * and each configured provider it has linked, by its label. When it was last active: its last
 * sign-in, or a live session used since — sessions slide for weeks, so a sign-in alone can be
 * that old for somebody here every day. Three reads for the whole list, never one per person.
 */
async function withSignInMethods(users: HydratedDocument<IUser>[]) {
  const ids = users.map((u) => u._id);
  const [withPassword, identities, sessionUse] = await Promise.all([
    passwordSignInEnabled()
      ? User.find({ _id: { $in: ids }, password: { $nin: [null, ""] } }).select("_id").lean()
      : Promise.resolve([] as { _id: unknown }[]),
    Identity.find({ user: { $in: ids }, ...liveIdentityFilter() }).select("user provider").sort({ linkedAt: 1 }).lean(),
    Session.aggregate<{ _id: unknown; lastUsedAt: Date }>([
      { $match: { user: { $in: ids } } },
      { $group: { _id: "$user", lastUsedAt: { $max: "$lastUsedAt" } } },
    ]),
  ]);
  const lastSessionUse = new Map(sessionUse.map((s) => [String(s._id), new Date(s.lastUsedAt).getTime()]));
  const hasPassword = new Set(withPassword.map((u) => String(u._id)));
  const providersOf = new Map<string, string[]>();
  for (const identity of identities) {
    const provider = providerById(identity.provider);
    if (!provider) continue;
    const label = provider.label;
    const list = providersOf.get(String(identity.user)) ?? [];
    if (!list.includes(label)) list.push(label);
    providersOf.set(String(identity.user), list);
  }
  return users.map((user) => ({
    ...user.toJSON(),
    lastActiveAt: latest(user.lastSignInAt?.getTime(), lastSessionUse.get(String(user._id))),
    signInMethods: [
      ...(hasPassword.has(String(user._id)) ? ["Password"] : []),
      ...(providersOf.get(String(user._id)) ?? []),
    ],
  }));
}

function latest(...times: (number | undefined)[]): string | null {
  const known = times.filter((t): t is number => typeof t === "number" && !Number.isNaN(t));
  return known.length ? new Date(Math.max(...known)).toISOString() : null;
}

export async function POST(request: Request) {
  if (!passwordSignInEnabled()) {
    return NextResponse.json(
      {
        error:
          "Password sign-in is turned off on this instance: the first account is set up with a sign-in provider, and everyone else is invited.",
      },
      { status: 403 }
    );
  }
  await connectDB();

  const read = await readJsonBody<{
    username?: string;
    password?: string;
    fullName?: string;
    email?: string;
    setupCode?: string;
    organisation?: string;
  }>(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const checked = checkNewAccount(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const { username: storedUsername, fullName: storedFullName, email, password } = checked.value;
  const organisation = checkOrganisationName(body.organisation);
  if (!organisation.ok) return NextResponse.json({ error: organisation.error }, { status: 400 });

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  // Declared out here because the audit row below names who did this, and on the bootstrap path
  // that is nobody: the first account on an instance is made by whoever reaches the login screen.
  let authUser: IUser | null = null;

  if (isBootstrap) {
    const refusal = provenanceRefusal(request);
    if (refusal) return refusal;
    const refused = await refuseSetupCode(getClientIp(request), body.setupCode);
    if (refused) return refused;
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
    if (isBootstrap && organisation.value) await nameOrganisation(organisation.value);
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
