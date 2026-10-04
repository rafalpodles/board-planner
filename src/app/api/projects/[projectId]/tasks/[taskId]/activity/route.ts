import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import type { ScopedDb } from "@/lib/db-scope";
import { withProjectAccess } from "@/lib/middleware";
import { editSessions, presentSessions, type ActivityHeader } from "@/lib/activity";
import { DELETED_AGENT, type IActivityLog } from "@/types";

const SHOWN = 100;
const SCANNED = 1000;

export const GET = withProjectAccess(async (_request, { params, db }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  // Verify task belongs to this project
  const taskExists = await db.Task.exists({ _id: taskId, project: projectId });
  if (!taskExists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // `_id` breaks a `createdAt` tie: one request can write several rows in a millisecond (BP-658)
  const headers = await db.ActivityLog.find({ task: taskId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(SCANNED)
    .select("user action field customField fieldType createdAt")
    .lean<ActivityHeader[]>();

  const all = editSessions(headers);
  // A session reaching the end of the scan may have begun before it, so its "before" is unknown
  if (headers.length === SCANNED && all.length > 1) all.pop();
  const sessions = all.slice(0, SHOWN);
  const ids = new Set(sessions.flatMap((s) => [String(s.newest._id), String(s.oldest._id)]));
  const rows = await db.ActivityLog.find({ _id: { $in: [...ids] } })
    .populate("user", "username fullName")
    .lean<IActivityLog[]>();
  const logs = await withAgentNames(db, presentSessions(sessions, rows));

  return NextResponse.json(logs);
});

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Agent rows written before BP-730 hold ids, not names
async function withAgentNames(db: ScopedDb, logs: IActivityLog[]): Promise<IActivityLog[]> {
  const agentRow = (log: IActivityLog) => log.action === "updated" && log.field === "agent" && !log.customField;
  const ids = new Set(
    logs.filter(agentRow).flatMap((log) => [log.oldValue, log.newValue].filter((v) => OBJECT_ID.test(v)))
  );
  if (ids.size === 0) return logs;
  const agents = await db.Agent.find({ _id: { $in: [...ids] } }, "name").lean<{ _id: unknown; name: string }[]>();
  const names = new Map(agents.map((agent) => [String(agent._id), agent.name]));
  const named = (value: string) => (OBJECT_ID.test(value) ? names.get(value) ?? DELETED_AGENT : value);
  return logs.map((log) =>
    agentRow(log) ? { ...log, oldValue: named(log.oldValue), newValue: named(log.newValue) } : log
  );
}
