import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { decryptSecret } from "@/lib/encryption";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";
import { McpClient } from "@/lib/pm/mcp-client";
import { isReadSafe } from "@/lib/pm/mcp-tools";

export const POST = withAdmin(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  let url: string;
  let token: string | undefined;

  if (typeof body.name === "string" && body.name) {
    const project = await Project.findById(projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const server = (project.pm?.mcpServers ?? []).find((s) => s.name === body.name);
    if (!server) {
      return NextResponse.json({ error: `No MCP server named "${body.name}"` }, { status: 404 });
    }
    url = server.url;
    token = server.authType === "bearer" && server.authToken ? decryptSecret(server.authToken) : undefined;
  } else {
    url = String(body.url ?? "").trim();
    if (!url || !isAllowedMcpServerUrl(url)) {
      return NextResponse.json({ error: "url must be a public https URL" }, { status: 400 });
    }
    token = body.authType === "bearer" && typeof body.authToken === "string" && body.authToken
      ? body.authToken
      : undefined;
  }

  try {
    const client = new McpClient(url, token);
    await client.initialize();
    const tools = await client.listTools();
    return NextResponse.json({
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({ name: t.name, readSafe: isReadSafe(t) })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
});
