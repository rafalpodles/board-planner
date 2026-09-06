import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin, withAuth } from "@/lib/middleware";
import { AgentBlock } from "@/models/agentBlock";
import { allBlocks, freeBlockKey, toApiBlock } from "@/lib/agent-service";
import { BLOCK_KINDS, STEP_CAPABILITIES, StepCapability } from "@/types";

export const GET = withAuth(async () => {
  await connectDB();
  const blocks = await allBlocks();
  return NextResponse.json(blocks.map(toApiBlock));
});

export const POST = withAdmin(async (request, { user }) => {
  await connectDB();
  const body = await request.json();

  const kind = BLOCK_KINDS.find((k) => k === body.kind);
  if (!kind) return NextResponse.json({ error: "kind must be step or gate" }, { status: 400 });

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });

  const key = await freeBlockKey(name);

  const params: Record<string, string> = {};
  if (body.params && typeof body.params === "object") {
    for (const [k, v] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") params[k] = String(v);
    }
  }

  const capability: StepCapability =
    STEP_CAPABILITIES.find((c) => c === body.capability) ?? "read-only";

  const block = await AgentBlock.create({
    key,
    kind,
    name,
    description: typeof body.description === "string" ? body.description.trim() : "",
    builtIn: false,
    gateKind: kind === "gate" && typeof body.gateKind === "string" ? body.gateKind : "",
    params: kind === "gate" ? params : {},
    prompt: kind === "step" && typeof body.prompt === "string" ? body.prompt.trim() : "",
    capability: kind === "step" ? capability : "read-only",
    model: kind === "step" && typeof body.model === "string" ? body.model : "",
    fallbackModel:
      kind === "step" && typeof body.fallbackModel === "string" ? body.fallbackModel : "",
    deterministic: false,
    createdBy: user._id,
  });

  return NextResponse.json(toApiBlock(block.toObject()), { status: 201 });
});
