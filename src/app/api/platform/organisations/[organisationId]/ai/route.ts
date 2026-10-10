import { NextResponse } from "next/server";
import { setAiLocked } from "@/lib/ai-gateway/lock";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

const MAX_REASON = 500;

// Switches the operator's AI key off for one organisation, or back on. Its own key is not touched
export const POST = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, body, params }) => {
  let parsed: { locked?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { locked } = parsed ?? {};
  const reason = parsed?.reason ?? "";
  if (typeof locked !== "boolean") return NextResponse.json({ error: "locked must be true or false" }, { status: 400 });
  if (typeof reason !== "string" || reason.length > MAX_REASON) {
    return NextResponse.json({ error: `reason must be a string of at most ${MAX_REASON} characters` }, { status: 400 });
  }

  if ((await setAiLocked(params.organisationId, locked, locked ? reason : "")) === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await logPlatformAudit({
    action: locked ? "organisation_ai_locked" : "organisation_ai_unlocked",
    keyId,
    subject: params.organisationId,
    detail: locked ? reason : "",
  });
  return NextResponse.json({ locked });
});
