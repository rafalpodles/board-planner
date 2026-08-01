import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { toApiWorker } from "@/lib/worker-service";

export const GET = withAdmin(async () => {
  await connectDB();

  const workers = await Worker.find().sort({ name: 1, host: 1 });
  const now = new Date();

  return NextResponse.json(workers.map((worker) => toApiWorker(worker, now)));
});
