import { NextResponse } from "next/server";
import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";

export { HELD_BY_PLAN, HELD_BY_PLAN_ON_THE_MACHINE } from "@/lib/machine-limit-copy";

export const FREE_MACHINE_LIMIT = 1;

const CONNECTED = { enabled: true, owner: { $ne: null } };

type Id = Types.ObjectId | string;

/** Null where there is no limit: self-hosted, and any organisation on Pro or its trial. */
export async function machineLimitOf(db: ScopedDb): Promise<number | null> {
  if (organisationDomain() === null) return null;
  return can(await getOrganisation(db.organisation), "workers.multiple") ? null : FREE_MACHINE_LIMIT;
}

/**
 * The connected machines that may claim work, the first connected first; null when every one may. A
 * record with no createdAt goes last, as lostCheckouts has it, so a legacy row never wins by accident.
 */
export async function claimingMachineIds(db: ScopedDb): Promise<Set<string> | null> {
  const limit = await machineLimitOf(db);
  if (limit === null) return null;
  const dated = await db.Worker.find({ ...CONNECTED, createdAt: { $ne: null } })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .select("_id")
    .lean();
  const undated =
    dated.length < limit
      ? await db.Worker.find({ ...CONNECTED, createdAt: null })
          .sort({ _id: 1 })
          .limit(limit - dated.length)
          .select("_id")
          .lean()
      : [];
  return new Set([...dated, ...undated].map((worker) => String(worker._id)));
}

export function isHeldByPlan(
  worker: { _id: unknown; enabled?: boolean; owner?: unknown },
  claiming: Set<string> | null
): boolean {
  return claiming !== null && !!worker.enabled && !!worker.owner && !claiming.has(String(worker._id));
}

export async function ownsConnectedMachine(db: ScopedDb, owner: Id): Promise<boolean> {
  return !!(await db.Worker.exists({ ...CONNECTED, owner }));
}

interface Connecting {
  /**
   * The machine being registered and who it will belong to. One already theirs connects nothing new;
   * one nobody owns is adopted, which does.
   */
  machine?: { name: string; host: string; owner: Id };
  /** The one being switched back on, which is not counted against itself */
  workerId?: Id;
}

/** 402 when connecting one more machine would pass the limit, null when there is room. */
export async function machineLimitRefusal(db: ScopedDb, connecting: Connecting = {}): Promise<NextResponse | null> {
  const limit = await machineLimitOf(db);
  if (limit === null) return null;
  const { machine, workerId } = connecting;
  if (machine && (await db.Worker.exists({ name: machine.name, host: machine.host, owner: machine.owner }))) return null;
  const machines = await db.Worker.countDocuments(workerId ? { ...CONNECTED, _id: { $ne: workerId } } : CONNECTED);
  if (machines < limit) return null;
  return NextResponse.json(
    {
      error: `This organisation is on the Free plan, which connects ${limit === 1 ? "one machine for workers and agents, and one is" : `${limit} machines for workers and agents, and they are`} already connected. Pro connects any number.`,
      feature: "workers.multiple",
      plan: "free",
      limit,
    },
    { status: 402 }
  );
}
