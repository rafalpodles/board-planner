import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";
import { McpClient } from "@/lib/pm/mcp-client";
import { isReadSafe, resolveServerToken } from "@/lib/pm/mcp-tools";

export const POST = withProjectOwner(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  let url = String(body.url ?? "").trim();
  let token: string | undefined;

  if (body.authType === "bearer" && typeof body.authToken === "string" && body.authToken) {
    token = body.authToken;
  } else if ((body.authType === "bearer" || body.authType === "oauth") && typeof body.name === "string" && body.name) {
    // Fallback to stored credentials so a saved server can be tested without retyping
    const project = await Project.findById(projectId).select("pm.mcpServers");
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const server = (project.pm?.mcpServers ?? []).find((s) => s.name === body.name);
    if (!server) {
      return NextResponse.json({ error: `No MCP server named "${body.name}" — provide a token` }, { status: 404 });
    }
    token = await resolveServerToken(projectId, server);
    if (server.authType === "oauth" && !token) {
      return NextResponse.json({ error: "OAuth connection not established — click Connect first" }, { status: 400 });
    }
    // A credential resolved from storage may only ever be sent to the url it was saved
    // against — never a caller-supplied one, or a stored secret could be redirected anywhere.
    url = server.url;
  }

  if (!url || !isAllowedMcpServerUrl(url)) {
    return NextResponse.json({ error: "url must be a public https URL" }, { status: 400 });
  }

  try {
    const client = new McpClient(url, token);
    await client.initialize();
    const tools = await client.listTools();
    return NextResponse.json({
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        readSafe: isReadSafe(t),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
});
