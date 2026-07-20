import { IPmConfig, IPmMcpServer, PM_MCP_AUTH_TYPES, PmMcpAuthType } from "@/types";
import { encryptSecret, decryptSecret } from "@/lib/encryption";
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
    const oauthClientId = String(server.oauthClientId ?? "").trim();
    const oauthClientSecret = String(server.oauthClientSecret ?? "");
    if (oauthClientId.length > 200 || oauthClientSecret.length > 500) {
      return { valid: false, error: `MCP server manual OAuth client credentials too long (${name})` };
    }

    cleanServers.push({
      name,
      url,
      authType: authType as PmMcpAuthType,
      authToken,
      allowWrites: server.allowWrites === true,
      toolAllowlist: toolAllowlist.map((t: string) => t.trim()),
      enabled: server.enabled !== false,
      // Transient manual-override fields, consumed by mergeMcpServerTokens
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
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

const EMPTY_OAUTH = {
  clientId: "",
  clientSecret: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  registrationEndpoint: "",
  redirectUri: "",
  scopes: [] as string[],
  tokenAuthMethod: "none",
  accessToken: "",
  refreshToken: "",
  expiresAt: null,
  status: "unconfigured" as const,
};

export function mergeMcpServerTokens(
  incoming: IPmMcpServer[],
  existing: IPmMcpServer[] | undefined
): { valid: true; value: IPmMcpServer[] } | { valid: false; error: string } {
  const stored = new Map((existing ?? []).map((s) => [s.name, s]));
  const merged: IPmMcpServer[] = [];
  for (const server of incoming) {
    const prior = stored.get(server.name);
    const authToken = server.authToken
      ? encryptSecret(server.authToken)
      : prior?.authToken ?? "";
    if (server.authType === "bearer" && !authToken) {
      return {
        valid: false,
        error: `MCP server "${server.name}" uses bearer auth but has no token — provide one (renaming a server requires re-entering its token)`,
      };
    }

    // OAuth state is server-managed: preserve it across saves, but drop tokens
    // when the URL changes (they were issued for a different resource).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transient = server as any;
    let oauth = prior?.oauth ? { ...prior.oauth } : undefined;
    if (server.authType === "oauth") {
      oauth = oauth ?? { ...EMPTY_OAUTH };
      if (prior && prior.url !== server.url) {
        oauth = { ...EMPTY_OAUTH, clientId: oauth.clientId, clientSecret: oauth.clientSecret };
      }
      if (transient.oauthClientId) {
        oauth.clientId = transient.oauthClientId;
      }
      if (transient.oauthClientSecret) {
        oauth.clientSecret = encryptSecret(transient.oauthClientSecret);
      }
    }
    delete transient.oauthClientId;
    delete transient.oauthClientSecret;

    merged.push({ ...server, authToken, oauth });
  }
  return { valid: true, value: merged };
}

export function resolveMcpAuthToken(server: Pick<IPmMcpServer, "authType" | "authToken">): string | undefined {
  return server.authType === "bearer" && server.authToken ? decryptSecret(server.authToken) : undefined;
}

export function sanitizeMcpServers(
  servers: IPmMcpServer[] | undefined
): Array<Omit<IPmMcpServer, "authToken" | "oauth"> & {
  hasAuthToken: boolean;
  oauthStatus?: string;
  oauthClientId?: string;
}> {
  return (servers ?? []).map((s) => ({
    name: s.name,
    url: s.url,
    authType: s.authType,
    allowWrites: s.allowWrites,
    toolAllowlist: s.toolAllowlist,
    enabled: s.enabled,
    hasAuthToken: !!s.authToken,
    ...(s.authType === "oauth"
      ? { oauthStatus: s.oauth?.status ?? "unconfigured", oauthClientId: s.oauth?.clientId ?? "" }
      : {}),
  }));
}

export function isPmAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}
