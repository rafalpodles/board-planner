import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { getAuthUser, PASSWORD_COST_FACTOR } from "@/lib/auth";
import { ProvenanceError, provenanceRefusal } from "@/lib/session";
import { withAdmin } from "@/lib/middleware";
import { User } from "@/models/user";

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

  const body = await request.json();
  const { username, password, fullName } = body;

  if (!username || !password || !fullName) {
    return NextResponse.json(
      { error: "username, password, and fullName are required" },
      { status: 400 }
    );
  }

  const userCount = await User.countDocuments();
  const isBootstrap = userCount === 0;

  if (isBootstrap) {
    const refusal = provenanceRefusal(request);
    if (refusal) return refusal;
  } else {
    let authUser;
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
      username: username.toLowerCase(),
      password: hashedPassword,
      fullName,
      role: isBootstrap ? "admin" : "member",
    });
    return NextResponse.json(user, { status: 201 });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return NextResponse.json(
        { error: "Username already exists" },
        { status: 409 }
      );
    }
    throw err;
  }
}
