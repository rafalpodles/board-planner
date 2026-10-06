import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { licencePullConfig, pullEveryLicence } from "@/lib/licence-pull";

export async function POST() {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  const config = licencePullConfig();
  if (!config) return NextResponse.json({ error: "LICENCE_SERVICE_URL is not set" }, { status: 409 });
  await pullEveryLicence(config);
  return new NextResponse(null, { status: 204 });
}
