import { NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { ApiToken } from "@/models/apiToken";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const tokens = await ApiToken.find({ user: user._id })
    .select("name prefix lastUsedAt createdAt")
    .sort({ createdAt: -1 });

  return NextResponse.json(tokens);
});

export const POST = withAuth(async (request, { user }) => {
  await connectDB();

  const { name } = await request.json();
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Token name is required" }, { status: 400 });
  }

  // Generate token: cp_ + 40 random hex chars
  const rawToken = `cp_${crypto.randomBytes(20).toString("hex")}`;
  const prefix = rawToken.substring(0, 11); // "cp_" + 8 hex
  const tokenHash = await bcrypt.hash(rawToken, 10);

  const token = await ApiToken.create({
    user: user._id,
    name: name.trim(),
    tokenHash,
    prefix,
  });

  // Return the raw token ONCE — it's never stored or retrievable again
  return NextResponse.json({
    _id: token._id,
    name: token.name,
    prefix: token.prefix,
    token: rawToken,
    createdAt: token.createdAt,
  }, { status: 201 });
});

export const DELETE = withAuth(async (request, { user }) => {
  await connectDB();

  const { id } = await request.json();
  if (!id) {
    return NextResponse.json({ error: "Token id is required" }, { status: 400 });
  }

  const result = await ApiToken.findOneAndDelete({ _id: id, user: user._id });
  if (!result) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
