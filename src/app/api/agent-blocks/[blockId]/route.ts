import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import type { ScopedDb } from "@/lib/db-scope";
import { allBlocks, toApiBlock } from "@/lib/agent-service";
import {
  capabilityRefusal,
  gateKindRefusal,
  gateParams,
  modelRefusal,
} from "@/lib/agent-block-input";
import { brokenProblems, normaliseComposition } from "@/lib/agent-rules";
import { AGENT_BUCKETS, ApiAgentBlock, IAgentBlock, StoredComposition } from "@/types";

// Both shapes are stored. $elemMatch, not a bare string: the path is a subdocument array, and a
// bare string there is a CastError that took the whole request down (BP-460).
function agentsNaming(key: string) {
  return {
    $or: AGENT_BUCKETS.flatMap((bucket) => [
      { [`composition.${bucket}.key`]: key },
      { [`composition.${bucket}`]: { $elemMatch: { $eq: key } } },
    ]),
  };
}

interface AgentNamingBlock {
  name: string;
  scope: string;
  composition?: unknown;
  owner: { _id: unknown; username: string } | null;
}

function agentsUsing(db: ScopedDb, key: string, fields: string): Promise<AgentNamingBlock[]> {
  return db.Agent.find(agentsNaming(key), `${fields} scope owner`)
    .sort({ name: 1 })
    .populate<{ owner: AgentNamingBlock["owner"] }>("owner", "username")
    .lean() as Promise<AgentNamingBlock[]>;
}

// /api/agents sends a personal agent only to its owner: an admin is told whom to ask, not its name
function agentLabel(agent: AgentNamingBlock, viewerId: string): string {
  if (agent.scope !== "user" || String(agent.owner?._id) === viewerId) return agent.name;
  return `a personal agent of ${agent.owner?.username ?? "a deleted account"}`;
}

type Body = Record<string, unknown>;

function fieldRefusal(block: IAgentBlock, body: Body): string | null {
  const sent = (field: string) => body[field] !== undefined;
  if (block.kind === "gate") {
    if (sent("gateKind")) {
      const unknown = gateKindRefusal(body.gateKind);
      if (unknown) return unknown;
      if (body.gateKind !== block.gateKind) {
        return "A gate's kind is fixed. Create a new gate to check something else.";
      }
    }
    const stepOnly = ["prompt", "capability", "model"].find(sent);
    if (stepOnly) return `A gate has no ${stepOnly}`;
    return sent("params") ? gateParams(block.gateKind, body.params).refusal : null;
  }
  if (sent("gateKind")) return "A step has no gateKind";
  if (sent("params")) return "A step has no params";
  if (block.deterministic) {
    const modelOnly = ["capability", "model"].find(sent);
    return modelOnly ? `This step is an action the worker takes, so it has no ${modelOnly}` : null;
  }
  return capabilityRefusal(body.capability) ?? modelRefusal(body.model, "model");
}

const MOST_NAMED = 3;

/** Each agent already naming the block that its new capability would leave broken, and why. */
async function agentsBrokenBy(
  db: ScopedDb,
  changed: ApiAgentBlock,
  previousCapability: ApiAgentBlock["capability"],
  viewerId: string
): Promise<string | null> {
  const agents = await agentsUsing(db, changed.key, "name composition");
  if (agents.length === 0) return null;

  const blocks = (await allBlocks()).map(toApiBlock);
  const stored = (key: string) => blocks.find((b) => b.key === key);
  // Only the capability differs between the two, so a rename in the same save cannot read as a new problem
  const before = (key: string) =>
    key === changed.key ? { ...changed, capability: previousCapability } : stored(key);
  const after = (key: string) => (key === changed.key ? changed : stored(key));

  const broken = agents.flatMap((agent) => {
    const composition = normaliseComposition(agent.composition as StoredComposition);
    const already = new Set(brokenProblems(composition, before).map((p) => p.message));
    const fresh = brokenProblems(composition, after).filter((p) => !already.has(p.message));
    if (fresh.length === 0) return [];
    return [`This would break ${agentLabel(agent, viewerId)}: ${fresh[0].message}`];
  });
  if (broken.length === 0) return null;
  const rest = broken.length - MOST_NAMED;
  return [...broken.slice(0, MOST_NAMED), ...(rest > 0 ? [`And ${rest} more.`] : [])].join(" ");
}

// The key is the contract with the worker and with every agent that already names it, so a rename
// changes the label and never the key.
export const PUT = withAuth(async (request, { params, user, db }) => {
  const { blockId } = await params;
  // An id that is not one reaches Mongoose as a CastError and answers 500; this is a 404.
  if (!isValidObjectId(blockId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const block = await db.AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn && user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can change a built-in block" },
      { status: 403 }
    );
  }
  // Authoring a block became instance-admin in BP-345, and editing one is authoring its prompt
  // again — the field the worker executes. Ownership is no longer enough on its own: blocks created
  // by ordinary members before that change still name them as `createdBy`, and a `createdBy` that
  // is empty for any reason used to leave the block editable by anyone at all.
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can change a block" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const refusal = fieldRefusal(block, body);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  const previousCapability = block.capability;
  const capabilityChanged = body.capability !== undefined && body.capability !== previousCapability;
  if (typeof body.name === "string" && body.name.trim()) block.name = body.name.trim();
  if (typeof body.description === "string") block.description = body.description.trim();
  if (block.kind === "step" && typeof body.prompt === "string") block.prompt = body.prompt.trim();
  if (body.capability !== undefined) block.capability = body.capability;
  if (body.model !== undefined) block.model = body.model;
  if (block.kind === "gate" && body.params && typeof body.params === "object") {
    block.params = gateParams(block.gateKind, body.params).params;
  }

  if (capabilityChanged) {
    const breaks = await agentsBrokenBy(
      db,
      toApiBlock(block.toObject()),
      previousCapability,
      String(user._id)
    );
    if (breaks) return NextResponse.json({ error: breaks }, { status: 409 });
  }

  await block.save();
  return NextResponse.json(toApiBlock(block.toObject()));
});

export const DELETE = withAuth(async (_request, { params, user, db }) => {
  const { blockId } = await params;
  // An id that is not one reaches Mongoose as a CastError and answers 500; this is a 404.
  if (!isValidObjectId(blockId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const block = await db.AgentBlock.findById(blockId);
  if (!block) return NextResponse.json({ error: "No such block" }, { status: 404 });
  if (block.builtIn) {
    return NextResponse.json(
      { error: "A built-in block cannot be deleted — the worker implements it" },
      { status: 400 }
    );
  }
  // Same bar as authoring and editing, and for the same reason as PUT above: ownership alone left
  // pre-BP-345 member-authored blocks, and any block with an empty createdBy, open to anyone.
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only an instance admin can delete a block" },
      { status: 403 }
    );
  }

  // Deleting a block an agent still names would leave that agent referring to nothing, and the
  // worker refuses an unknown key mid-run rather than at the moment somebody caused it.
  const users = await agentsUsing(db, block.key, "name");

  if (users.length > 0) {
    const named = users.map((agent) => agentLabel(agent, String(user._id))).join(", ");
    return NextResponse.json(
      { error: `Still used by ${named}. Take it out of those agents first.` },
      { status: 409 }
    );
  }

  await block.deleteOne();
  return NextResponse.json({ ok: true });
});
