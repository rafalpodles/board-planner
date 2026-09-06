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
  const storedUsername = String(username).trim().toLowerCase();
  if (!isValidUsername(storedUsername)) {
    return NextResponse.json({ error: USERNAME_RULE }, { status: 400 });
  }
  const storedFullName = normaliseFullName(String(fullName));
  if (!isValidFullName(storedFullName)) {
    return NextResponse.json({ error: FULL_NAME_RULE }, { status: 400 });
  }
  if (body.email !== undefined && typeof body.email !== "string") {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: "That does not look like an email address" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

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
