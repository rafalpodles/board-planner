import { NextResponse } from "next/server";
import { withAuth } from "@/lib/middleware";
import { getBuildInfo } from "@/lib/build-info";

export const GET = withAuth(async () => NextResponse.json(getBuildInfo()));
