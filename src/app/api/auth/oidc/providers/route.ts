import { NextResponse } from "next/server";
import { publicProviders } from "@/lib/oidc/providers";

export async function GET() {
  return NextResponse.json(publicProviders());
}
