const MASK = "••••";

const TOKEN_FIELDS = ["githubToken", "gitlabToken", "codaToken"] as const;

// CP-246 dropped these paths from the schema without a backfill, so every project older than that
// deploy still stores them. Mongoose keeps unmapped keys in _doc and toObject() clones _doc whole,
// so they reach the client unless removed here.
const REMOVED_FIELDS = ["owner", "admins"] as const;

export function maskSecretUrl(value: string | undefined): string {
  if (!value) return "";

  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return MASK;
  }

  const tail = value.length - origin.length > 4 ? value.slice(-4) : "";
  return `${origin}/${MASK}${tail}`;
}

/**
 * Strips every credential a project carries before it reaches a client. Both project
 * routes hand-rolled this and disagreed, which is how the list route ended up returning
 * GitLab and Coda tokens to every member.
 *
 * Masked values land under a different key on purpose: a client that never holds
 * `webhookUrl` cannot echo the mask back and overwrite the real URL with dots.
 */
export function sanitizeProjectSecrets<T extends object>(project: T): T {
  const obj = project as Record<string, unknown>;

  for (const field of TOKEN_FIELDS) {
    obj[`${field}Set`] = !!obj[field];
    delete obj[field];
  }

  for (const field of REMOVED_FIELDS) {
    delete obj[field];
  }

  if (Array.isArray(obj.notificationChannels)) {
    obj.notificationChannels = obj.notificationChannels.map((channel) => {
      const { webhookUrl, ...rest } = channel as Record<string, unknown>;
      return { ...rest, webhookUrlMasked: maskSecretUrl(webhookUrl as string | undefined) };
    });
  }

  if (Array.isArray(obj.webhooks)) {
    obj.webhooks = obj.webhooks.map((webhook) => {
      const { url, ...rest } = webhook as Record<string, unknown>;
      return { ...rest, urlMasked: maskSecretUrl(url as string | undefined) };
    });
  }

  return project;
}
