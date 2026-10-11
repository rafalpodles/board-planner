import { OPENROUTER_BASE_URL } from "@/lib/pm/openrouter";

export interface CatalogueModel {
  id: string;
  name: string;
}

const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

let cached: { at: number; models: CatalogueModel[] } | null = null;

export function forgetCatalogue(): void {
  cached = null;
}

/** OpenRouter's public list of models; null when it cannot be read, which a caller treats as "unknown", never as "none" */
export async function listCatalogue(): Promise<CatalogueModel[] | null> {
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.models;
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL()}/models`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const rows = (await res.json())?.data;
    if (!Array.isArray(rows)) return null;
    type Row = { id?: unknown; name?: unknown; architecture?: { output_modalities?: unknown } };
    const models = (rows as Row[])
      .filter((row): row is Row & { id: string } => typeof row?.id === "string")
      // A model that writes no text cannot run the PM agent or AI Assist; one that says nothing about it is kept
      .filter((row) => {
        const out = row.architecture?.output_modalities;
        return !Array.isArray(out) || out.includes("text");
      })
      .map((row) => ({ id: row.id, name: typeof row.name === "string" ? row.name : row.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (models.length === 0) return null;
    cached = { at: Date.now(), models };
    return models;
  } catch {
    return null;
  }
}

/** A variant suffix (`:online`) is not part of the id OpenRouter lists, though some variants (`:free`) are listed as ids of their own */
export const isListed = (catalogue: CatalogueModel[], model: string): boolean => {
  const base = model.split(":")[0];
  return catalogue.some((m) => m.id === model || m.id === base);
};

export type KeyCheck = "valid" | "rejected" | "unknown";

/** Whether OpenRouter accepts the key. Only a definite 401 or 403 is "rejected": an outage must not stop a key being saved */
export async function checkKey(key: string): Promise<KeyCheck> {
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL()}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return "valid";
    return res.status === 401 || res.status === 403 ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
}
