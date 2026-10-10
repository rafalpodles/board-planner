import { NextResponse } from "next/server";
import { setAiAllowance, type AllowanceChange } from "@/lib/ai-gateway/allowance";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";

const MAX_TOKENS = 1_000_000_000_000;
const MAX_REASON = 500;

/**
 * What one organisation may spend of the operator's key, in place of its plan's, for the counter it is on now (a trial's,
 * or the month's): {"tokens": 5000000} sets it, {"unlimited": true} lifts the limit, {"tokens": null} gives it its
 * plan's figure back. A figure of 0 is refused: it would read as "nothing" and act as "no limit".
 */
export const PUT = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, body, params }) => {
  let parsed: { tokens?: unknown; unlimited?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { tokens, unlimited, reason = "" } = parsed ?? {};
  const limited = tokens !== undefined && tokens !== null;
  if (unlimited !== undefined && unlimited !== true) return NextResponse.json({ error: "unlimited can only be true" }, { status: 400 });
  if (unlimited === true && tokens !== undefined) return NextResponse.json({ error: "Send tokens or unlimited, not both" }, { status: 400 });
  if (unlimited !== true && tokens === undefined) return NextResponse.json({ error: "Send tokens, or unlimited: true" }, { status: 400 });
  if (limited && !(typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 1 && tokens <= MAX_TOKENS)) {
    return NextResponse.json({ error: `tokens must be a whole number from 1 to ${MAX_TOKENS}, or null; send unlimited: true to lift the limit` }, { status: 400 });
  }
  if (typeof reason !== "string" || reason.length > MAX_REASON) {
    return NextResponse.json({ error: `reason must be a string of at most ${MAX_REASON} characters` }, { status: 400 });
  }
  const change: AllowanceChange = unlimited === true ? { unlimited: true } : limited ? { tokens: tokens as number } : { clear: true };
  const outcome = await setAiAllowance(params.organisationId, change);
  if (outcome.status === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { aiAllowance } = outcome;
  const scope = aiAllowance?.scope;
  const what = unlimited === true ? `no limit (${scope})` : `${tokens} (${scope})`;
  await logPlatformAudit({
    action: aiAllowance ? "ai_allowance_set" : "ai_allowance_cleared",
    keyId,
    subject: params.organisationId,
    detail: aiAllowance ? `${what}${reason ? `: ${reason}` : ""}` : reason,
  });
  return NextResponse.json({ aiAllowance });
});
