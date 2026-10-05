import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { forgetOrganisationSlugs } from "@/lib/organisation-host";

// A spec that reseeds organisations under a running server would otherwise read the old host answers for 30 s
export async function POST() {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  forgetOrganisationSlugs();
  return new NextResponse(null, { status: 204 });
}
