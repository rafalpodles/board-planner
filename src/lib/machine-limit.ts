import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";

export const FREE_MACHINE_LIMIT = 1;

const CONNECTED = { enabled: true, owner: { $ne: null } };

export { HELD_BY_PLAN } from "@/lib/machine-limit-copy";

/** Null where there is no limit: self-hosted, and any organisation on Pro or its trial. */
export async function machineLimitOf(db: ScopedDb): Promise<number | null> {
  if (organisationDomain() === null) return null;
  return can(await getOrganisation(db.organisation), "workers.multiple") ? null : FREE_MACHINE_LIMIT;
}

/** The connected machines that may claim work, the first connected first; null when every one may. */
export async function claimingMachineIds(db: ScopedDb): Promise<Set<string> | null> {
  const limit = await machineLimitOf(db);
  if (limit === null) return null;
  const first = await db.Worker.find(CONNECTED).sort({ createdAt: 1, _id: 1 }).limit(limit).select("_id").lean();
  return new Set(first.map((worker) => String(worker._id)));
}

export function isHeldByPlan(
  worker: { _id: unknown; enabled?: boolean; owner?: unknown },
  claiming: Set<string> | null
): boolean {
  return claiming !== null && !!worker.enabled && !!worker.owner && !claiming.has(String(worker._id));
}

interface Reconnecting {
  /** A machine with this name and host already exists, so registering it again connects nothing new */
  machine?: { name: string; host: string };
  /** The one being switched back on, which is not counted against itself */
  workerId?: Types.ObjectId | string;
  /** Somebody who owns a connected machine may be about to connect that same one again */
  owner?: Types.ObjectId | string;
}

/** 402 when connecting one more machine would pass the limit, null when there is room. */
export async function machineLimitRefusal(db: ScopedDb, reconnecting: Reconnecting = {}): Promise<NextResponse | null> {
  const limit = await machineLimitOf(db);
  if (limit === null) return null;
  const { machine, workerId, owner } = reconnecting;
  if (machine && (await db.Worker.exists({ name: machine.name, host: machine.host }))) return null;
  if (owner && (await db.Worker.exists({ ...CONNECTED, owner }))) return null;
  const machines = await db.Worker.countDocuments(workerId ? { ...CONNECTED, _id: { $ne: workerId } } : CONNECTED);
  if (machines < limit) return null;
  return NextResponse.json(
    {
      error: `This organisation is on the Free plan, which connects ${limit === 1 ? "one machine" : `${limit} machines`} for workers and agents, and has ${machines} connected. Upgrade to Pro to connect more.`,
      feature: "workers.multiple",
      plan: "free",
      machines,
      limit,
    },
    { status: 402 }
  );
}
