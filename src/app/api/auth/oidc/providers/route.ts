import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { scopedForRequest } from "@/lib/db-scope";
import { refusedHost } from "@/lib/middleware";
import { publicProvidersFor } from "@/lib/oidc/providers";

export async function GET(request: Request) {
  const db = await scopedForRequest(request);
  if (!db) return refusedHost(request);
  await connectDB();
  return NextResponse.json(await publicProvidersFor(db));
}
