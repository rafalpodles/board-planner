import { readAuthenticatedJsonBody } from "@/lib/request-body";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin, withAuth } from "@/lib/middleware";
import { allBlocks, freeBlockKey, toApiBlock } from "@/lib/agent-service";
import {
  capabilityRefusal,
  fallbackForProviderRefusal,
  modelForProviderRefusal,
  providerRefusal,
  gateKindRefusal,
  gateParams,
} from "@/lib/agent-block-input";
import { DEFAULT_PROVIDER, isProvider, ProviderId } from "@/lib/agent-kinds";
import { BLOCK_KINDS, STEP_CAPABILITIES, StepCapability } from "@/types";

export const GET = withAuth(async (_request, { db }) => {
  await connectDB();
  const blocks = await allBlocks(db);
  return NextResponse.json(blocks.map(toApiBlock));
});

// A step block is a prompt the worker runs on the operator's machine with writes allowed, so
// authoring one is an instance-level act, not something any account on the board may do. Composing
// an agent out of existing blocks stays open (POST /api/agents), and choosing which agent a task
// runs under is a project-admin act (updateTask) — those three together are what stop an ordinary
// member reaching the machine. BP-345.
export const POST = withAdmin(async (request, { user, db }) => {
  await connectDB();
  const read = await readAuthenticatedJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;

  const kind = BLOCK_KINDS.find((k) => k === body.kind);
  if (!kind) return NextResponse.json({ error: "kind must be step or gate" }, { status: 400 });

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });

  const gate = kind === "gate" ? gateParams(body.gateKind, body.params) : null;
  const provider: ProviderId = isProvider(body.provider) ? body.provider : DEFAULT_PROVIDER;
  const refusal =
    kind === "gate"
      ? (gateKindRefusal(body.gateKind) ?? gate!.refusal)
      : (capabilityRefusal(body.capability) ??
        providerRefusal(body.provider) ??
        modelForProviderRefusal(provider, body.model, "model") ??
        fallbackForProviderRefusal(provider, body.fallbackModel));
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  const key = await freeBlockKey(db, name);

  const capability: StepCapability =
    STEP_CAPABILITIES.find((c) => c === body.capability) ?? "read-only";

  const block = await db.AgentBlock.create({
    key,
    kind,
    name,
    description: typeof body.description === "string" ? body.description.trim() : "",
    builtIn: false,
    gateKind: kind === "gate" ? body.gateKind : "",
    // Values, never patterns or commands: the worker owns what a gate does, this says how strictly
    params: gate?.params ?? {},
    prompt: kind === "step" && typeof body.prompt === "string" ? body.prompt.trim() : "",
    capability: kind === "step" ? capability : "read-only",
    provider: kind === "step" ? provider : DEFAULT_PROVIDER,
    model: kind === "step" && typeof body.model === "string" ? body.model : "",
    fallbackModel:
      kind === "step" && typeof body.fallbackModel === "string" ? body.fallbackModel : "",
    deterministic: false,
    createdBy: user._id,
  });

  return NextResponse.json(toApiBlock(block.toObject()), { status: 201 });
});
