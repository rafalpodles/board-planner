import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { selfOrigin } from "@/lib/session";
import { providerById } from "@/lib/oidc/providers";
import { redirectUri } from "@/lib/oidc/flow";
import { relayOrigin } from "@/lib/oidc/relay";
import { OidcFlow } from "@/models/oidcFlow";

const EXPIRED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in expired</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0; opacity: 0.8; }
</style>
</head>
<body>
<h1>This sign-in has expired</h1>
<p>It was already used, or took too long. Go back to your workspace and sign in again.</p>
</body>
</html>
`;

function expired() {
  return new NextResponse(EXPIRED_PAGE, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!relayOrigin()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const provider = providerById((await params).provider);
  const { search, searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  if (!provider || !state) return expired();

  const home = selfOrigin();
  if (!home) return NextResponse.json({ error: "PUBLIC_ORIGIN is not set" }, { status: 500 });

  await connectDB();
  const live = await OidcFlow.exists({ state, provider: provider.id, claims: null, expiresAt: { $gt: new Date() } });
  if (!live) return expired();
  return NextResponse.redirect(`${redirectUri(provider, home)}${search}`, 303);
}
