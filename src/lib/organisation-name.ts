export const ORGANISATION_NAME_MAX = 80;

export function checkOrganisationName(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "organisation must be a string" };
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length > ORGANISATION_NAME_MAX) {
    return { ok: false, error: `organisation is at most ${ORGANISATION_NAME_MAX} characters` };
  }
  return { ok: true, value: name || null };
}
