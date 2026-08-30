import { z } from "zod";

/**
 * BP-497: `z.object(shape)` drops a key the shape does not declare, so a call naming a parameter
 * the tool never had was answered 200 having written nothing — and the one field that did move,
 * `updatedAt`, is the one that reads as proof something was written. Strict input turns the stray
 * key into a refusal the caller can act on, and `additionalProperties: false` in the advertised
 * schema says so before the call is made.
 *
 * `hints` names the replacement where there is one, so the refusal points somewhere.
 */
export function strictInput<Shape extends z.ZodRawShape>(
  shape: Shape,
  hints: Record<string, string> = {}
) {
  const message = (keys: string[]) =>
    `Not a parameter of this tool: ${keys
      .map((key) => (hints[key] ? `"${key}" — use ${hints[key]}` : `"${key}"`))
      .join("; ")}. Nothing was written.`;

  type Issue = { code: string; keys?: string[] };
  // zod 3 spells this hook errorMap and zod 4 spells it error; mcp-server is on a different major
  // from the app, and passing both is what lets this file stay identical on either side.
  const params = {
    errorMap: (issue: Issue, ctx: { defaultError: string }) =>
      issue.code === "unrecognized_keys" && issue.keys
        ? { message: message(issue.keys) }
        : { message: ctx.defaultError },
    error: (issue: Issue) =>
      issue.code === "unrecognized_keys" && issue.keys ? message(issue.keys) : undefined,
  };

  return z.object(shape, params as never).strict();
}

export const NOTHING_TO_CHANGE = "named nothing to change. Nothing was written.";

const TASK_FIELD_HINTS: Record<string, string> = {
  checklist: "acceptanceCriteria, a markdown checklist",
  difficulty: "the fields parameter, keyed by field name",
  component: "the fields parameter, keyed by field name",
  customFieldValues: "the fields parameter, keyed by field name",
};

export const CREATE_TASK_HINTS: Record<string, string> = {
  ...TASK_FIELD_HINTS,
  agent: "update_task, once the task exists",
};

export const UPDATE_TASK_HINTS: Record<string, string> = {
  ...TASK_FIELD_HINTS,
  status: "the change_task_status tool",
};
