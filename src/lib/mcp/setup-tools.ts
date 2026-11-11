import { z } from "zod";
import { echo } from "@/lib/echo";
import { PROJECT_KEY_RULE } from "@/lib/identifiers";
import { isRunnable, normaliseComposition } from "@/lib/agent-rules";
import { effectiveColumns } from "@/lib/columns";
import { GATE_KINDS, PROVIDER_IDS } from "@/lib/agent-kinds";
import {
  AGENT_BUCKETS,
  COLUMN_ROLES,
  GRANT_RELATIONS,
  PROJECT_ICONS,
  STEP_CAPABILITIES,
  TRIAGE_MODES,
  type ApiAgentBlock,
  type ApiCustomField,
  type ApiTaskTemplate,
} from "@/types";
import type { McpProject, PlannerClient } from "./planner-client";
import { clientFrom, json, type RegisterTool } from "./tool-kit";
import { strictInput, NOTHING_TO_CHANGE } from "./strict-input";
import { COLOUR_PARAM, columnSummary, fieldSummary, findField, requireOwner } from "./board-config";
import {
  columnsInOrder,
  columnsUpdated,
  columnsWithout,
  compositionFrom,
  findAgent,
  findBlock,
  optionsUpdated,
  optionsWithout,
  type AgentRow,
  type CompositionInput,
} from "./setup-edit";

const CANDIDATES_SHOWN = 10;
const PROJECT_PARAM = z.string().describe("Project key (e.g. 'CP')");
const SECRET_HINT = "the app: Settings → Integrations, so a token never passes through a conversation";

const COMPOSITION_ENTRY = z.union([
  z.string(),
  z
    .object({
      block: z.string().describe("The step or gate, by key or name"),
      params: z.record(z.string(), z.string()).optional().describe("Overrides the gate's parameters for this position only"),
    })
    .strict(),
]);

const COMPOSITION_PARAM = z
  .object(
    Object.fromEntries(AGENT_BUCKETS.map((bucket) => [bucket, z.array(COMPOSITION_ENTRY).optional()])) as Record<
      (typeof AGENT_BUCKETS)[number],
      z.ZodOptional<z.ZodArray<typeof COMPOSITION_ENTRY>>
    >
  )
  .strict()
  .describe(
    `What the agent runs, in order, bucket by bucket (${AGENT_BUCKETS.join(", ")}). Each entry is a step or gate by ` +
      "key or name — list_agent_blocks lists them — or { block, params } to set a gate's parameters here."
  );

const GATE_GUIDE = GATE_KINDS.map(
  (kind) => `${kind.key} (${kind.description}${kind.params.length ? ` params: ${kind.params.map((p) => p.key).join(", ")}` : ""})`
).join("; ");

const blockLine = (block: ApiAgentBlock) => ({
  key: block.key,
  name: block.name,
  kind: block.kind,
  description: block.description,
  builtIn: block.builtIn,
  ...(block.kind === "gate"
    ? { gateKind: block.gateKind, params: block.params }
    : { capability: block.capability, provider: block.provider, model: block.model, prompt: block.prompt }),
});

const agentLine = (agent: { name: string; scope: string; projectName?: string | null; description?: string; composition?: Record<string, { key: string; params?: Record<string, string> }[]> }) => ({
  name: agent.name,
  scope: agent.scope,
  ...(agent.projectName ? { project: agent.projectName } : {}),
  description: agent.description ?? "",
  composition: agent.composition,
});

const templateLine = (t: ApiTaskTemplate) => ({
  name: t.name,
  title: t.title,
  category: t.category,
  description: t.description,
  acceptanceCriteria: t.acceptanceCriteria,
});

function storedCategory(name: string, categories: { name: string }[]): string {
  const wanted = name.trim().toLowerCase();
  const found = categories.find((c) => c.name.trim().toLowerCase() === wanted);
  if (!found) {
    throw new Error(`No category "${echo(name.trim())}". Categories: ${categories.map((c) => c.name).join(", ") || "none"}`);
  }
  return found.name;
}

function defaultAgentId(name: string, agents: AgentRow[], projectId: string): string {
  const shared = agents.filter((a) => a.scope !== "user");
  const wanted = name.trim().toLowerCase();
  if (!shared.some((a) => a.name.trim().toLowerCase() === wanted) && agents.some((a) => a.name.trim().toLowerCase() === wanted)) {
    throw new Error(`"${echo(name.trim())}" is a personal agent, and a board's default must be the board's own or a global one. Nothing was written.`);
  }
  const found = findAgent(name, shared, projectId);
  if (!isRunnable(normaliseComposition(found.composition))) {
    throw new Error(`"${echo(found.name)}" has no steps yet, so it cannot be offered first. Nothing was written.`);
  }
  return found._id;
}

async function ownedProject(client: PlannerClient, project: string, what: string): Promise<McpProject> {
  const proj = await client.getProjectByKey(project);
  requireOwner(proj, project, what);
  return proj;
}

async function personOnBoard(client: PlannerClient, projectId: string, username: string) {
  const wanted = username.trim().toLowerCase();
  const members = await client.listProjectMembers(projectId);
  const member = members.find((m) => m.username.toLowerCase() === wanted);
  if (member) return member;
  const candidates = wanted.length >= 2 ? await client.findMemberCandidates(projectId, wanted) : [];
  const candidate = candidates.find((c) => c.username.toLowerCase() === wanted);
  if (candidate) return { ...candidate, relation: null };
  if (candidates.length >= CANDIDATES_SHOWN) {
    throw new Error(
      `"${echo(username.trim())}" is part of more usernames than the search returns, and not among them. Add them in the app: Settings → Members.`
    );
  }
  throw new Error(
    `No active account "${echo(username.trim())}" in this organisation. Inviting somebody new is done in the app: Settings → Members.`
  );
}

export function registerSetupTools(registerTool: RegisterTool): void {
  // --- Projects ---

  registerTool(
    "create_project",
    {
      description:
        "Create a board, with the caller as its owner. Needs an instance admin, as in the app. The key prefixes every " +
        "task (KEY-1) and cannot be changed afterwards. The board starts with the default columns and categories; " +
        "add people with set_member, and configure columns, fields and categories with the board tools.",
      inputSchema: strictInput(
        {
          name: z.string().describe("The board's name"),
          key: z.string().describe(`${PROJECT_KEY_RULE}, e.g. 'WEB'`),
          description: z.string().optional(),
          icon: z.string().optional().describe(`One of: ${PROJECT_ICONS.join(", ")}`),
          repositoryUrl: z.string().optional().describe("The GitHub or GitLab repository the board's pull requests come from"),
          pmEnabled: z.boolean().optional().describe("Switch the PM agent on for this board"),
        },
        { writes: true, hints: { members: "set_member, once the board exists", columns: "add_column, update_column and remove_column" } }
      ),
    },
    async ({ name, key, description, icon, repositoryUrl, pmEnabled }, extra) => {
      const client = clientFrom(extra);
      const created = await client.createProject({
        name,
        key,
        ...(description !== undefined ? { description } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
        ...(pmEnabled !== undefined ? { pm: { enabled: pmEnabled } } : {}),
      });
      return json({
        key: created.key,
        name: created.name,
        url: client.projectUrl(created.key),
        columns: effectiveColumns(created.columns).map(columnSummary),
      });
    }
  );

  registerTool(
    "update_project",
    {
      description:
        "Change a board's settings: name, description, icon, AI triage, repositories, the estimate field, the default " +
        "agent and the PM agent's notes and schedule. Needs the project owner. Only what is named changes. Switching the " +
        "PM agent on or off needs an instance admin; workers and integration tokens are set in the app.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          name: z.string().optional(),
          description: z.string().optional(),
          icon: z.string().optional().describe(`One of: ${PROJECT_ICONS.join(", ")}, or "" for none`),
          triageMode: z.enum(TRIAGE_MODES).optional().describe("What AI triage does with a new task: off, suggest, or auto (applies)"),
          repositoryUrl: z.string().optional().describe("The primary repository; \"\" removes it"),
          additionalRepositories: z
            .array(z.object({ url: z.string(), name: z.string().optional() }).strict())
            .optional()
            .describe("The repositories after the primary, replacing the list"),
          estimateField: z.string().optional().describe("The number field estimates are read from, by name or id; \"\" for none"),
          deploymentEnvironment: z.string().optional().describe("The GitHub deployment environment counted as production"),
          defaultAgent: z
            .string()
            .optional()
            .describe("The agent the task picker offers first, by name (a project or global agent); \"\" for none"),
          pm: z
            .object({
              enabled: z.boolean().optional().describe("Instance admin only"),
              contextNotes: z.string().optional().describe("What the PM agent should know about this board"),
              dailyReview: z.boolean().optional().describe("Run board reviews on a schedule"),
              reviewHour: z.number().int().min(0).max(23).optional(),
              reviewIntervalHours: z.number().int().min(1).max(24).optional(),
              timezone: z.string().optional().describe("IANA zone the review hour is read in"),
              handleNeedsHumanReview: z.boolean().optional().describe("Review tasks entering the needs-a-person column"),
            })
            .strict()
            .optional(),
        },
        {
          writes: true,
          hints: {
            key: "nothing: a project key cannot be changed",
            githubToken: SECRET_HINT,
            gitlabToken: SECRET_HINT,
            codaToken: SECRET_HINT,
            worker: "the app: Settings → Workers, from a person's session",
          },
        }
      ),
    },
    async (args, extra) => {
      const { project, defaultAgent, estimateField, pm, ...plain } = args;
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "change the board's settings");
      const named = Object.entries(plain).filter(([, v]) => v !== undefined);
      if (named.length === 0 && defaultAgent === undefined && estimateField === undefined && pm === undefined) {
        throw new Error(`update_project ${NOTHING_TO_CHANGE}`);
      }

      const agentId =
        defaultAgent === undefined ? undefined : defaultAgent ? defaultAgentId(defaultAgent, (await client.listAgents()) as AgentRow[], proj._id) : "";
      const full = await client.getProject(proj._id);
      const data: Record<string, unknown> = Object.fromEntries(named);
      if (estimateField !== undefined) {
        data.estimateFieldId = estimateField ? String(findField(estimateField, full.customFields ?? [])._id) : "";
      }
      if (pm !== undefined) {
        const { enabled, contextNotes, ...schedule } = pm;
        const scheduled = Object.entries(schedule).filter(([, v]) => v !== undefined);
        data.pm = {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(contextNotes !== undefined ? { contextNotes } : {}),
          ...(scheduled.length > 0 ? { autonomy: Object.fromEntries(scheduled) } : {}),
        };
      }
      if (Object.keys(data).length > 0) await client.updateProject(proj._id, data);

      if (agentId !== undefined) await client.setDefaultAgent(proj._id, agentId);

      const after = (await client.getProject(proj._id)) as McpProject & Record<string, unknown>;
      return json({
        key: after.key,
        name: after.name,
        description: after.description,
        icon: after.icon,
        triageMode: after.triageMode,
        repositoryUrl: after.repositoryUrl,
        estimateFieldId: after.estimateFieldId,
        pm: (() => {
          const p = after.pm as { enabled?: boolean; contextNotes?: string; autonomy?: Record<string, unknown> } | undefined;
          return p ? { enabled: p.enabled, contextNotes: p.contextNotes, autonomy: p.autonomy } : undefined;
        })(),
      });
    }
  );

  // --- People ---

  registerTool(
    "find_people",
    {
      description:
        "Search the organisation's people who are not yet on a board, by username or name (at least 2 characters), to " +
        "add with set_member. Needs the project owner. Somebody with no account yet is invited in the app.",
      inputSchema: strictInput({ project: PROJECT_PARAM, query: z.string().min(2) }),
    },
    async ({ project, query }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "look for people to add");
      const people = await client.findMemberCandidates(proj._id, query.trim());
      return json(people.map((p) => ({ username: p.username, fullName: p.fullName ?? "" })));
    }
  );

  registerTool(
    "set_member",
    {
      description:
        "Give an existing account access to a board, or change what it holds there: owner (manages the board) or " +
        "member. Needs the project owner. A board keeps at least one owner. Inviting somebody who has no account yet is " +
        "done in the app.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          username: z.string().describe("The person's username — find_people searches for one"),
          relation: z.enum(GRANT_RELATIONS),
        },
        { writes: true, hints: { email: "the app: Settings → Members invites by address" } }
      ),
    },
    async ({ project, username, relation }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "change who is on the board");
      const person = await personOnBoard(client, proj._id, username);
      await client.setMember(proj._id, person._id, relation);
      return json({ username: person.username, relation, before: person.relation });
    }
  );

  registerTool(
    "remove_member",
    {
      description:
        "Take a person's access to a board away. Needs the project owner; the last owner cannot be removed. An instance " +
        "admin keeps reaching every board whatever their access here.",
      inputSchema: strictInput({ project: PROJECT_PARAM, username: z.string() }, { writes: true }),
    },
    async ({ project, username }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "remove somebody from the board");
      const wanted = username.trim().toLowerCase();
      const member = (await client.listProjectMembers(proj._id)).find((m) => m.username.toLowerCase() === wanted && m.relation);
      if (!member) throw new Error(`${echo(username.trim())} has no access of their own to ${echo(project.toUpperCase())}. Nothing was changed.`);
      await client.removeMember(proj._id, member._id);
      return json({ removed: member.username, was: member.relation });
    }
  );

  registerTool(
    "group_roles",
    {
      description:
        "Read or replace which identity-provider groups give which role on a board: at each single sign-on, a person " +
        "in a group is given that access. Needs the project owner and an OpenID Connect provider. Without map, reads; " +
        "with map, replaces the whole list ([] removes every mapping).",
      inputSchema: strictInput({
        project: PROJECT_PARAM,
        map: z
          .array(z.object({ group: z.string(), role: z.enum(GRANT_RELATIONS) }).strict())
          .optional()
          .describe("The whole mapping"),
      }, { writes: true }),
    },
    async ({ project, map }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "map groups to roles");
      return json(map === undefined ? await client.getGroupRoles(proj._id) : await client.setGroupRoles(proj._id, map));
    }
  );

  // --- Agents ---

  registerTool(
    "list_agent_blocks",
    {
      description:
        "The steps and gates an agent is composed of, by key: a step is a prompt a worker runs with a coding CLI, a " +
        "gate a check the worker makes. create_agent and update_agent name them.",
      inputSchema: strictInput({}),
    },
    async (_args, extra) => json((await clientFrom(extra).listAgentBlocks()).map(blockLine))
  );

  registerTool(
    "create_agent",
    {
      description:
        "Compose an agent out of existing steps and gates. With project, it is that board's agent (needs the project " +
        "owner); without, a personal one only its owner can hand their own tasks to. An agent with no steps is a draft " +
        "that cannot run. A sequence that runs something before the gate meant to vet it is refused.",
      inputSchema: strictInput(
        {
          name: z.string(),
          description: z.string().optional(),
          project: PROJECT_PARAM.optional().describe("Project key, for a board's agent; omit for a personal one"),
          composition: COMPOSITION_PARAM,
        },
        { writes: true }
      ),
    },
    async ({ name, description, project, composition }, extra) => {
      const client = clientFrom(extra);
      const projectId = project ? (await client.getProjectByKey(project))._id : undefined;
      const agent = await client.createAgent({
        name,
        ...(description !== undefined ? { description } : {}),
        ...(projectId ? { projectId } : {}),
        composition: compositionFrom(composition as CompositionInput, await client.listAgentBlocks()),
      });
      return json(agentLine(agent));
    }
  );

  registerTool(
    "update_agent",
    {
      description:
        "Rename an agent, change its description, or replace what it runs. A board's agent needs the project owner, a " +
        "personal one its owner, a global one an instance admin. Emptying an agent that tasks or a board still name is " +
        "refused. Only what is named changes; composition replaces the whole sequence.",
      inputSchema: strictInput(
        {
          agent: z.string().describe("The agent, by name — list_agents lists them"),
          project: PROJECT_PARAM.optional().describe("The board, when two agents share the name"),
          name: z.string().optional().describe("The new name"),
          description: z.string().optional(),
          composition: COMPOSITION_PARAM.optional(),
        },
        { writes: true }
      ),
    },
    async ({ agent, project, name, description, composition }, extra) => {
      if (name === undefined && description === undefined && composition === undefined) {
        throw new Error(`update_agent ${NOTHING_TO_CHANGE}`);
      }
      const client = clientFrom(extra);
      const projectId = project ? (await client.getProjectByKey(project))._id : undefined;
      const found = findAgent(agent, (await client.listAgents()) as AgentRow[], projectId);
      const updated = await client.updateAgent(found._id, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(composition !== undefined
          ? { composition: compositionFrom(composition as CompositionInput, await client.listAgentBlocks()) }
          : {}),
      });
      return json(agentLine(updated));
    }
  );

  const stepFields = {
    prompt: z.string().optional().describe("Step only: what the coding CLI is told to do"),
    capability: z.enum(STEP_CAPABILITIES).optional().describe("Step only: read-only, or edit (may change files)"),
    provider: z.string().optional().describe(`Step only: the coding CLI, one of ${PROVIDER_IDS.join(", ")}`),
    model: z.string().optional().describe("Step only: the model, as that CLI names it"),
  };

  registerTool(
    "create_agent_block",
    {
      description:
        "Add a step or a gate to the catalog agents are composed from. Needs an instance admin: a step's prompt runs " +
        `on people's machines with the capability given. A gate is one of the checks the worker implements: ${GATE_GUIDE}.`,
      inputSchema: strictInput(
        {
          kind: z.enum(["step", "gate"]),
          name: z.string(),
          description: z.string().optional(),
          ...stepFields,
          fallbackModel: z.string().optional().describe("Step only: the model tried when the first is unavailable"),
          gateKind: z.string().optional().describe(`Gate only: ${GATE_KINDS.map((k) => k.key).join(", ")}`),
          params: z.record(z.string(), z.string()).optional().describe("Gate only: its limits, as text"),
        },
        { writes: true }
      ),
    },
    async (args, extra) => {
      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return json(blockLine(await clientFrom(extra).createAgentBlock(body)));
    }
  );

  registerTool(
    "update_agent_block",
    {
      description:
        "Change a step or gate: its name, description, a step's prompt, capability, CLI and model, or a gate's " +
        "parameters. Needs an instance admin. The key never changes, so agents naming it keep working; a capability " +
        "that would break an agent using the step is refused. A gate's kind is fixed.",
      inputSchema: strictInput(
        {
          block: z.string().describe("The step or gate, by key or name"),
          name: z.string().optional(),
          description: z.string().optional(),
          ...stepFields,
          params: z.record(z.string(), z.string()).optional().describe("Gate only: its limits, as text"),
        },
        { writes: true }
      ),
    },
    async ({ block, ...changes }, extra) => {
      const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) throw new Error(`update_agent_block ${NOTHING_TO_CHANGE}`);
      const client = clientFrom(extra);
      const found = findBlock(block, await client.listAgentBlocks());
      return json(blockLine(await client.updateAgentBlock(found._id, body)));
    }
  );

  registerTool(
    "delete_agent_block",
    {
      description:
        "Remove a step or gate from the catalog. Needs an instance admin. A built-in one, or one an agent still names, " +
        "is refused — take it out of those agents first.",
      inputSchema: strictInput({ block: z.string().describe("The step or gate, by key or name") }, { writes: true }),
    },
    async ({ block }, extra) => {
      const client = clientFrom(extra);
      const found = findBlock(block, await client.listAgentBlocks());
      await client.deleteAgentBlock(found._id);
      return json({ deleted: found.key });
    }
  );

  // --- Board configuration ---

  const columnsAnswer = (columns: Parameters<typeof columnSummary>[0][]) => ({
    columns: effectiveColumns(columns).map((c) => ({ ...columnSummary(c), triggersPmReview: !!c.triggersPmReview })),
  });

  registerTool(
    "update_column",
    {
      description:
        "Change one column's role, colour, or whether a task entering it asks the PM agent for a review. Needs the " +
        "project owner. The id and tasks stay; rename_column changes the label. A board must keep a column with the " +
        "active role and one with the done role. update_column, reorder_columns and remove_column save the whole column " +
        "list, so run them one at a time, not alongside another column change.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          column: z.string().describe("The column, by id or label"),
          role: z.enum(COLUMN_ROLES).optional(),
          color: COLOUR_PARAM.describe("A colour, #rrggbb"),
          triggersPmReview: z.boolean().optional(),
        },
        { writes: true, hints: { label: "rename_column" } }
      ),
    },
    async ({ project, column, role, color, triggersPmReview }, extra) => {
      if (role === undefined && color === undefined && triggersPmReview === undefined) {
        throw new Error(`update_column ${NOTHING_TO_CHANGE}`);
      }
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "change a column");
      const full = await client.getProject(proj._id);
      const change = {
        ...(role !== undefined ? { role } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(triggersPmReview !== undefined ? { triggersPmReview } : {}),
      };
      return json(columnsAnswer(await client.replaceColumns(proj._id, columnsUpdated(full.columns, column, change))));
    }
  );

  registerTool(
    "remove_column",
    {
      description:
        "Remove a column from a board. Needs the project owner. Refused while any task, archived ones included, is in " +
        "it — move them first — and when it is the board's last column with the active or done role.",
      inputSchema: strictInput({ project: PROJECT_PARAM, column: z.string().describe("The column, by id or label") }, { writes: true }),
    },
    async ({ project, column }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "remove a column");
      const full = await client.getProject(proj._id);
      return json(columnsAnswer(await client.replaceColumns(proj._id, columnsWithout(full.columns, column))));
    }
  );

  registerTool(
    "reorder_columns",
    {
      description: "Put a board's columns in a new order, left to right. Needs the project owner. Name every column, by id or label.",
      inputSchema: strictInput(
        { project: PROJECT_PARAM, columns: z.array(z.string()).min(1).describe("Every column, in the new order") },
        { writes: true }
      ),
    },
    async ({ project, columns }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "reorder the columns");
      const full = await client.getProject(proj._id);
      return json(columnsAnswer(await client.replaceColumns(proj._id, columnsInOrder(full.columns, columns))));
    }
  );

  const fieldAnswer = (fields: ApiCustomField[], fieldId: string) => {
    const field = fields.find((f) => String(f._id) === fieldId);
    return { field: field ? fieldSummary(field) : null };
  };

  registerTool(
    "update_custom_field",
    {
      description:
        "Rename a project-defined field or change how it shows: required, on the card, in the list, filterable, or " +
        "archived (hidden, values kept). Any member of the board may, as in the app. Only what is named changes.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          field: z.string().describe("The field, by name or id"),
          name: z.string().optional().describe("The new name"),
          required: z.boolean().optional(),
          showOnCard: z.boolean().optional(),
          showInList: z.boolean().optional(),
          filterable: z.boolean().optional(),
          archived: z.boolean().optional(),
        },
        { writes: true, hints: { options: "update_field_option, remove_field_option and add_field_option" } }
      ),
    },
    async ({ project, field, ...changes }, extra) => {
      const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) throw new Error(`update_custom_field ${NOTHING_TO_CHANGE}`);
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const found = findField(field, (await client.getProject(proj._id)).customFields ?? []);
      return json(fieldAnswer(await client.updateCustomField(proj._id, String(found._id), body), String(found._id)));
    }
  );

  registerTool(
    "delete_custom_field",
    {
      description:
        "Delete a project-defined field and the value every task holds in it. This cannot be undone; " +
        "update_custom_field with archived: true hides a field and keeps its values. Needs the project owner. " +
        "confirmName has to repeat the field's name.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          field: z.string().describe("The field, by name or id"),
          confirmName: z.string().describe("The field's name, to confirm"),
        },
        { writes: true }
      ),
    },
    async ({ project, field, confirmName }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "delete a field");
      const found = findField(field, (await client.getProject(proj._id)).customFields ?? []);
      if (found.name.trim().toLowerCase() !== confirmName.trim().toLowerCase()) {
        throw new Error(`Not deleted: confirmName "${echo(confirmName)}" is not the field's name, "${echo(found.name)}". Nothing was written.`);
      }
      const fields = await client.deleteCustomField(proj._id, String(found._id));
      return json({ deleted: found.name, fields: fields.map((f) => f.name) });
    }
  );

  registerTool(
    "update_field_option",
    {
      description:
        "Rename or recolour one option of a dropdown or multiselect field. Tasks holding it keep it under the new name. " +
        "Any member of the board may. It saves the field's whole option list, so do not run it alongside another " +
        "option change on the same field.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          field: z.string().describe("The field, by name or id"),
          option: z.string().describe("The option, by its value or id"),
          value: z.string().optional().describe("The new name"),
          color: COLOUR_PARAM.describe("A colour, #rrggbb"),
        },
        { writes: true }
      ),
    },
    async ({ project, field, option, value, color }, extra) => {
      if (value === undefined && color === undefined) throw new Error(`update_field_option ${NOTHING_TO_CHANGE}`);
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const found = findField(field, (await client.getProject(proj._id)).customFields ?? []);
      const options = optionsUpdated(found, option, { value, color });
      return json(fieldAnswer(await client.updateCustomField(proj._id, String(found._id), { options }), String(found._id)));
    }
  );

  registerTool(
    "remove_field_option",
    {
      description:
        "Remove one option from a dropdown or multiselect field; tasks holding it lose that value. Needs the project " +
        "owner. It saves the field's whole option list, so do not run it alongside another option change on the same field.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          field: z.string().describe("The field, by name or id"),
          option: z.string().describe("The option, by its value or id"),
        },
        { writes: true }
      ),
    },
    async ({ project, field, option }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "remove an option");
      const found = findField(field, (await client.getProject(proj._id)).customFields ?? []);
      const options = optionsWithout(found, option);
      return json(fieldAnswer(await client.updateCustomField(proj._id, String(found._id), { options }), String(found._id)));
    }
  );

  registerTool(
    "update_category",
    {
      description:
        "Rename or recolour a category. Tasks filed under it move with the rename. Any member of the board may.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          category: z.string().describe("The category's current name"),
          name: z.string().optional().describe("The new name"),
          color: COLOUR_PARAM.describe("A colour, #rrggbb"),
        },
        { writes: true }
      ),
    },
    async ({ project, category, name, color }, extra) => {
      if (name === undefined && color === undefined) throw new Error(`update_category ${NOTHING_TO_CHANGE}`);
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const categories = await client.updateCategory(proj._id, {
        name: storedCategory(category, (await client.getProject(proj._id)).categories ?? []),
        ...(name !== undefined ? { newName: name } : {}),
        ...(color !== undefined ? { color } : {}),
      });
      return json({ categories: categories.map((c) => ({ name: c.name, color: c.color })) });
    }
  );

  registerTool(
    "delete_category",
    {
      description:
        "Delete a category no task is filed under. Needs the project owner; a board keeps at least one category.",
      inputSchema: strictInput({ project: PROJECT_PARAM, category: z.string() }, { writes: true }),
    },
    async ({ project, category }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "delete a category");
      const categories = await client.deleteCategory(
        proj._id,
        storedCategory(category, (await client.getProject(proj._id)).categories ?? [])
      );
      return json({ categories: categories.map((c) => c.name) });
    }
  );

  registerTool(
    "save_template",
    {
      description:
        "Create a task template, or change the one with this name. A template pre-fills the new-task form. Any member " +
        "of the board may. Only what is named changes on an existing template; get_project lists them.",
      inputSchema: strictInput(
        {
          project: PROJECT_PARAM,
          name: z.string().describe("The template's name; an existing one is changed"),
          rename: z.string().optional().describe("A new name for an existing template"),
          title: z.string().optional(),
          description: z.string().optional(),
          category: z.string().optional(),
          acceptanceCriteria: z.string().optional().describe("Markdown checklist"),
        },
        { writes: true }
      ),
    },
    async ({ project, name, rename, ...fields }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const templates = ((await client.getProject(proj._id)) as { taskTemplates?: ApiTaskTemplate[] }).taskTemplates ?? [];
      const existing = templates.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!existing && rename !== undefined) throw new Error(`No template "${echo(name.trim())}" to rename. Nothing was written.`);
      const saved = existing
        ? await client.updateTemplate(proj._id, existing._id, { ...body, ...(rename !== undefined ? { name: rename } : {}) })
        : await client.addTemplate(proj._id, { name, ...body });
      const wanted = (rename ?? name).trim().toLowerCase();
      const template = saved.find((t) => t.name.trim().toLowerCase() === wanted);
      return json({ created: !existing, template: template ? templateLine(template) : null, templates: saved.map((t) => t.name) });
    }
  );

  registerTool(
    "delete_template",
    {
      description: "Delete a task template. Needs the project owner. Tasks made from it are not touched.",
      inputSchema: strictInput({ project: PROJECT_PARAM, name: z.string() }, { writes: true }),
    },
    async ({ project, name }, extra) => {
      const client = clientFrom(extra);
      const proj = await ownedProject(client, project, "delete a template");
      const templates = ((await client.getProject(proj._id)) as { taskTemplates?: ApiTaskTemplate[] }).taskTemplates ?? [];
      const existing = templates.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!existing) throw new Error(`No template "${echo(name.trim())}". Templates: ${templates.map((t) => t.name).join(", ") || "none"}`);
      const saved = await client.deleteTemplate(proj._id, existing._id);
      return json({ deleted: existing.name, templates: saved.map((t) => t.name) });
    }
  );
}
