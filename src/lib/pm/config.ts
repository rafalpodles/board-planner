import { IPmConfig, IPmMcpServer, PM_MCP_AUTH_TYPES, PmMcpAuthType } from "@/types";
import { encryptSecret } from "@/lib/encryption";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";

const MAX_MODEL_LENGTH = 100;
const MAX_NOTES_LENGTH = 5000;
const MAX_LINKS = 20;
const MAX_LABEL_LENGTH = 100;
const MAX_URL_LENGTH = 500;
const MAX_MCP_SERVERS = 5;
const MAX_MCP_ALLOWLIST = 50;
const MCP_NAME_RE = /^[a-z0-9-]{1,32}$/;

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
  const dailyTurnCap = pm.dailyTurnCap ?? 0;
  if (
    typeof dailyTurnCap !== "number" ||
    !Number.isInteger(dailyTurnCap) ||
    dailyTurnCap < 0 ||
    dailyTurnCap > 1000
  ) {
    return { valid: false, error: "pm.dailyTurnCap must be an integer 0-1000 (0 = server default)" };
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

  const mcpServers = pm.mcpServers ?? [];
  if (!Array.isArray(mcpServers) || mcpServers.length > MAX_MCP_SERVERS) {
    return { valid: false, error: `pm.mcpServers must be an array of up to ${MAX_MCP_SERVERS} items` };
  }
  const cleanServers: IPmMcpServer[] = [];
  const seenNames = new Set<string>();
  for (const server of mcpServers) {
    if (typeof server !== "object" || server === null) {
      return { valid: false, error: "pm.mcpServers entries must be objects" };
    }
    const name = String(server.name ?? "").trim();
    if (!MCP_NAME_RE.test(name)) {
      return { valid: false, error: "MCP server name must be a slug: [a-z0-9-], 1-32 chars" };
    }
    if (seenNames.has(name)) {
      return { valid: false, error: `Duplicate MCP server name: ${name}` };
    }
    seenNames.add(name);
    const url = String(server.url ?? "").trim();
    if (!url || url.length > MAX_URL_LENGTH || !isAllowedMcpServerUrl(url)) {
      return { valid: false, error: `MCP server URL must be a public https URL up to ${MAX_URL_LENGTH} chars (${name})` };
    }
    const authType = server.authType ?? "none";
    if (!PM_MCP_AUTH_TYPES.includes(authType)) {
      return { valid: false, error: `MCP server authType must be one of: ${PM_MCP_AUTH_TYPES.join(", ")}` };
    }
    const authToken = server.authToken ?? "";
    if (typeof authToken !== "string" || authToken.length > 500) {
      return { valid: false, error: `MCP server authToken must be a string up to 500 chars (${name})` };
    }
    const toolAllowlist = server.toolAllowlist ?? [];
    if (
      !Array.isArray(toolAllowlist) ||
      toolAllowlist.length > MAX_MCP_ALLOWLIST ||
      toolAllowlist.some((t: unknown) => typeof t !== "string" || !String(t).trim() || String(t).length > 100)
    ) {
      return { valid: false, error: `MCP server toolAllowlist must be up to ${MAX_MCP_ALLOWLIST} non-empty tool names (${name})` };
    }
    cleanServers.push({
      name,
      url,
      authType: authType as PmMcpAuthType,
      authToken,
      allowWrites: server.allowWrites === true,
      toolAllowlist: toolAllowlist.map((t: string) => t.trim()),
      enabled: server.enabled !== false,
    });
  }

  return {
    valid: true,
    value: {
      enabled: pm.enabled,
      model: model.trim(),
      contextNotes,
      links: cleanLinks,
      dailyTurnCap,
      mcpServers: cleanServers,
    },
  };
}

// Tokens are write-only: an empty incoming token keeps the stored one
// (matched by server name); a new token is encrypted at rest.
export function mergeMcpServerTokens(
  incoming: IPmMcpServer[],
  existing: IPmMcpServer[] | undefined
): IPmMcpServer[] {
  const stored = new Map((existing ?? []).map((s) => [s.name, s.authToken]));
  return incoming.map((server) => ({
    ...server,
    authToken: server.authToken
      ? encryptSecret(server.authToken)
      : stored.get(server.name) ?? "",
  }));
}

export function sanitizeMcpServers(
  servers: IPmMcpServer[] | undefined
): Array<Omit<IPmMcpServer, "authToken"> & { hasAuthToken: boolean }> {
  return (servers ?? []).map((s) => ({
    name: s.name,
    url: s.url,
    authType: s.authType,
    allowWrites: s.allowWrites,
    toolAllowlist: s.toolAllowlist,
    enabled: s.enabled,
    hasAuthToken: !!s.authToken,
  }));
}

export function isPmAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}
