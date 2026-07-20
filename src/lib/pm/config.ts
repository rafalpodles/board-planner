import { IPmConfig } from "@/types";

const MAX_MODEL_LENGTH = 100;
const MAX_NOTES_LENGTH = 5000;
const MAX_LINKS = 20;
const MAX_LABEL_LENGTH = 100;
const MAX_URL_LENGTH = 500;

export function validatePmConfig(
  raw: unknown
): { valid: true; value: IPmConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "pm must be an object" };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pm = raw as Record<string, any>;

  if (typeof pm.enabled !== "boolean") {
    return { valid: false, error: "pm.enabled must be a boolean" };
  }
  const model = pm.model ?? "";
  if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH) {
    return { valid: false, error: `pm.model must be a string up to ${MAX_MODEL_LENGTH} chars` };
  }
  const contextNotes = pm.contextNotes ?? "";
  if (typeof contextNotes !== "string" || contextNotes.length > MAX_NOTES_LENGTH) {
    return { valid: false, error: `pm.contextNotes must be a string up to ${MAX_NOTES_LENGTH} chars` };
  }
  const links = pm.links ?? [];
  if (!Array.isArray(links) || links.length > MAX_LINKS) {
    return { valid: false, error: `pm.links must be an array of up to ${MAX_LINKS} items` };
  }
  const cleanLinks = [];
  for (const link of links) {
    if (typeof link !== "object" || link === null) {
      return { valid: false, error: "pm.links entries must be objects" };
    }
    const label = String(link.label ?? "").trim();
    const url = String(link.url ?? "").trim();
    if (!label || label.length > MAX_LABEL_LENGTH) {
      return { valid: false, error: `pm.links labels must be 1-${MAX_LABEL_LENGTH} chars` };
    }
    if (!url || url.length > MAX_URL_LENGTH) {
      return { valid: false, error: `pm.links urls must be 1-${MAX_URL_LENGTH} chars` };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { valid: false, error: `pm.links url is not a valid URL: ${url}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "pm.links urls must use http(s)" };
    }
    cleanLinks.push({ label, url });
  }

  return {
    valid: true,
    value: {
      enabled: pm.enabled,
      model: model.trim(),
      contextNotes,
      links: cleanLinks,
    },
  };
}

export function isPmAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}
