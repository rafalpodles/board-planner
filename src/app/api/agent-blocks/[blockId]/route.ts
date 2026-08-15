import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import { toApiBlock } from "@/lib/agent-service";
import { AGENT_BUCKETS } from "@/types";

// The key is the contract with the worker and with every agent that already names it, so a rename
// changes the label and never the key.
export const PUT = withAuth(async (request, { params, user }) => {
  const { blockId } = await params;
  await connectDB();

  const block = await AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn && user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can change a built-in block" },
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
  await connectDB();

  const block = await AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn) {
    return NextResponse.json(
      { error: "A built-in block cannot be deleted — the worker implements it" },
      { status: 400 }
    );
  }
  if (block.createdBy && String(block.createdBy) !== String(user._id) && user.role !== "admin") {
    return NextResponse.json({ error: "Not yours to delete" }, { status: 403 });
  }

  // Deleting a block an agent still names would leave that agent referring to nothing, and the
  // worker refuses an unknown key mid-run rather than at the moment somebody caused it.
  const users = await Agent.find(
    { $or: AGENT_BUCKETS.map((bucket) => ({ [`composition.${bucket}`]: block.key })) },
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
