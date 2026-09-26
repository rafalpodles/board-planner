import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { logProjectAudit } from "@/lib/projectAudit";
import { auditChange } from "@/lib/settings-audit";
import { serverNamed } from "@/lib/pm/oauth-writes";

export const POST = withProjectOwner(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const { name } = await request.json();

  // Keep the client registration and endpoints; drop only the tokens
  const before =
    typeof name === "string"
      ? await Project.findOneAndUpdate(
          {
            _id: projectId,
            "pm.mcpServers": { $elemMatch: { name, oauth: { $exists: true, $ne: null } } },
          },
          {
            $set: {
              "pm.mcpServers.$.oauth.accessToken": "",
              "pm.mcpServers.$.oauth.refreshToken": "",
              "pm.mcpServers.$.oauth.expiresAt": null,
              "pm.mcpServers.$.oauth.status": "unconfigured",
            },
          },
          { returnDocument: "before" }
        ).lean()
      : null;
  if (!before) {
    if (!(await Project.exists({ _id: projectId }))) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ error: `No OAuth connection named "${name}"` }, { status: 404 });
  }

  const oauth = serverNamed(before.pm?.mcpServers, name)?.oauth;
  const label = `PM MCP server ${name} · OAuth`;
  const line =
    auditChange(label, oauth?.status ?? "unconfigured", "unconfigured") ??
    (oauth?.accessToken || oauth?.refreshToken ? `${label} tokens cleared` : null);
  if (line) logProjectAudit(projectId, user._id, "settings_updated", line);

  return NextResponse.json({ ok: true });
});
