import { ApiClient } from "../api-client.js";

interface Project {
  _id: string;
  name: string;
  key: string;
  description: string;
  components: string[];
}

export function getProjectTools(client: ApiClient) {
  return {
    list_projects: {
      description: "List all projects in ClaudePlanner",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async () => {
        const projects = (await client.listProjects()) as Project[];
        return projects.map((p) => ({
          id: p._id,
          name: p.name,
          key: p.key,
          description: p.description,
          components: p.components,
        }));
      },
    },
    get_project: {
      description:
        "Get project details by project key (e.g. 'CP') or project ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          identifier: {
            type: "string",
            description: "Project key (e.g. 'CP') or project ID",
          },
        },
        required: ["identifier"],
      },
      handler: async (args: { identifier: string }) => {
        let project: Project;
        try {
          // Try as project ID first
          project = (await client.getProject(args.identifier)) as Project;
        } catch {
          // Fall back to key lookup
          project = (await client.getProjectByKey(args.identifier)) as Project;
        }
        return project;
      },
    },
  };
}
