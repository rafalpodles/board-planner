import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import { toApiBlock } from "@/lib/agent-service";
import { AGENT_BUCKETS } from "@/types";

export const PUT = withAuth(async (request, { params, user }) => {
  const { blockId } = await params;
  if (!isValidObjectId(blockId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const block = await AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn && user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can change a built-in block" },
      { status: 403 }
    );
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can change a block" },
      { status: 403 }
    );
  }

  const body = await request.json();
  if (typeof body.name === "string" && body.name.trim()) block.name = body.name.trim();
  if (typeof body.description === "string") block.description = body.description.trim();
  if (block.kind === "step" && typeof body.prompt === "string") block.prompt = body.prompt.trim();

  if (block.kind === "gate" && body.params && typeof body.params === "object") {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") params[k] = String(v);
    }
    block.params = params;
  }

  await block.save();
  return NextResponse.json(toApiBlock(block.toObject()));
});

export const DELETE = withAuth(async (_request, { params, user }) => {
  const { blockId } = await params;
  if (!isValidObjectId(blockId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const block = await AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn) {
    return NextResponse.json(
      { error: "A built-in block cannot be deleted — the worker implements it" },
      { status: 400 }
    );
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can delete a block" },
      { status: 403 }
    );
  }

  const users = await Agent.find(
    {
      $or: AGENT_BUCKETS.flatMap((bucket) => [
        { [`composition.${bucket}.key`]: block.key },
        { [`composition.${bucket}`]: { $elemMatch: { $eq: block.key } } },
      ]),
    },
    "name"
  ).lean();

  if (users.length > 0) {
    return NextResponse.json(
      {
        error: `Still used by ${users.map((a) => a.name).join(", ")}. Take it out of those agents first.`,
      },
      { status: 409 }
    );
  }

  await block.deleteOne();
  return NextResponse.json({ ok: true });
});
