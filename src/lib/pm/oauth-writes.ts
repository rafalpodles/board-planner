import { Project } from "@/models/project";

// Scoped to the address and the client the caller read: a server moved meanwhile is another
// server, and a client changed meanwhile has reset these fields itself (BP-315)
export function writeServerOauth(
  projectId: string,
  server: { name: string; url: string; oauth?: { clientId?: string } | null },
  fields: Record<string, unknown>
) {
  const clientId = server.oauth?.clientId;
  return Project.findOneAndUpdate(
    {
      _id: projectId,
      "pm.mcpServers": {
        $elemMatch: {
          name: server.name,
          url: server.url,
          "oauth.clientId": clientId ? clientId : { $in: ["", null] },
        },
      },
    },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [`pm.mcpServers.$.oauth.${key}`, value])
      ),
    },
    { returnDocument: "before" }
  ).lean();
}

export function serverNamed<T extends { name?: string }>(servers: T[] | undefined, name: string) {
  return (servers ?? []).find((s) => s.name === name);
}
