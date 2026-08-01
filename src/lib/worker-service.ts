import crypto from "crypto";
import bcrypt from "bcryptjs";
import { isValidObjectId } from "mongoose";
import { connectDB } from "./db";
import { Worker } from "@/models/worker";
import { IWorker } from "@/types";

export const PROTOCOL_VERSION = 1;
export const WORKER_STALE_MS = 5 * 60 * 1000;
export const WORKER_HEARTBEAT_MS = 60 * 1000;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function verdictFor(
  worker: IWorker,
  projectId: string,
  requestProtocol: number,
  now = new Date()
): Verdict {
  if (requestProtocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `this worker speaks protocol ${requestProtocol || "none"}; the server speaks ${PROTOCOL_VERSION}`,
    };
  }
  if (!worker.enabled) return { ok: false, reason: "this worker is disabled" };
  if (worker.lockedByInstance) return { ok: false, reason: "this worker is locked by the instance" };

  // A non-finite lastSeenAt (unparseable, missing) must count as maximally stale, not as fresh
  const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : NaN;
  const isFresh = Number.isFinite(seenAt) && now.getTime() - seenAt <= WORKER_STALE_MS;
  if (!isFresh) return { ok: false, reason: "this worker has not reported in" };

  // A falsy projectId must never match an assignment with no project via a shared String(undefined)
  const assigned =
    !!projectId &&
    (worker.assignments ?? []).some((a) => a.project != null && String(a.project) === String(projectId));
  if (!assigned) return { ok: false, reason: "this worker has no assignment for this project" };

  return { ok: true };
}

export async function registerWorker(input: {
  name: string;
  host: string;
  platform: string;
  version: string;
}): Promise<{ worker: IWorker; credential: string }> {
  await connectDB();
  const credential = `cpw_${crypto.randomBytes(32).toString("hex")}`;

  // Re-registration reclaims the identity rather than creating a ghost that holds the
  // assignments while the live worker sits idle with none
  const worker = await Worker.findOneAndUpdate(
    { name: input.name, host: input.host },
    {
      $set: {
        ...input,
        protocolVersion: PROTOCOL_VERSION,
        credentialHash: await bcrypt.hash(credential, 10),
        lastSeenAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return { worker: worker as IWorker, credential };
}

export async function verifyWorkerCredential(
  workerId: string,
  credential: string
): Promise<IWorker | null> {
  if (!isValidObjectId(workerId) || typeof credential !== "string") return null;
  await connectDB();
  // credentialHash is select: false on the schema; it must be asked for explicitly
  const worker = await Worker.findById(workerId).select("+credentialHash");
  if (!worker) return null;
  return (await bcrypt.compare(credential, worker.credentialHash)) ? worker : null;
}

export async function touchWorker(
  workerId: string,
  patch: Partial<Pick<IWorker, "protocolVersion" | "version" | "commandAckedAt" | "bindingError">> = {}
): Promise<void> {
  await connectDB();
  await Worker.updateOne({ _id: workerId }, { $set: { lastSeenAt: new Date(), ...patch } });
}
