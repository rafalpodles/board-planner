import { GRANT_RELATIONS, type GroupRole } from "@/types";

export const MAX_GROUP_ROLES = 50;
const MAX_GROUP = 200;

/** What an owner typed on a board's group mapping, or the one thing wrong with it. */
export function parseGroupRoleMap(body: unknown): { ok: true; value: GroupRole[] } | { ok: false; error: string } {
  const map = typeof body === "object" && body !== null ? (body as { map?: unknown }).map : undefined;
  if (!Array.isArray(map)) return { ok: false, error: "map must be a list of groups and roles" };
  if (map.length > MAX_GROUP_ROLES) return { ok: false, error: `A board maps at most ${MAX_GROUP_ROLES} groups` };
  const seen = new Set<string>();
  const value: GroupRole[] = [];
  for (const row of map) {
    const { group, role } = (typeof row === "object" && row !== null ? row : {}) as { group?: unknown; role?: unknown };
    const name = typeof group === "string" ? group.trim() : "";
    if (!name || name.length > MAX_GROUP || /[\x00-\x1f]/.test(name)) return { ok: false, error: `Each group must be 1 to ${MAX_GROUP} characters` };
    if (typeof role !== "string" || !GRANT_RELATIONS.includes(role as never)) return { ok: false, error: "Each role must be owner or member" };
    if (seen.has(name)) return { ok: false, error: `${name} is mapped twice` };
    seen.add(name);
    value.push({ group: name, role: role as GroupRole["role"] });
  }
  return { ok: true, value };
}
