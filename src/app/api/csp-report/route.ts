import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { ACCEPTED_REPORT_TYPES, MAX_REPORT_BYTES, admitReport, parseViolations } from "@/lib/csp-report";

export async function POST(req: Request) {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_REPORT_TYPES.has(type)) {
    return NextResponse.json({ error: "unsupported content type" }, { status: 415 });
  }

  const body = await readJsonBody<unknown>(req, MAX_REPORT_BYTES).catch(() => null);
  if (!body) return NextResponse.json({ error: "request body could not be read" }, { status: 400 });
  if (!body.ok) return body.response;

  for (const violation of parseViolations(body.value)) {
    if (!admitReport(Date.now())) break;
    console.warn(JSON.stringify({ event: "csp-violation", ...violation }));
  }
  return new NextResponse(null, { status: 204 });
}
