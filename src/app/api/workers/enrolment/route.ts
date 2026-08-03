import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { mintEnrolmentToken } from "@/lib/enrolment";

// Minting requires an interactive admin session, never an API token. An API token can be read off a
// disk the agent can also read, and one that could mint enrolment tokens would hand back the very
// power this credential exists to remove.
export const POST = withAdmin(async (request, { user }) => {
  await connectDB();

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 200) : "";

  const { token, expiresAt } = await mintEnrolmentToken(String(user._id), label);

  // Returned once and never retrievable again — only its hash is stored
  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() }, { status: 201 });
});
