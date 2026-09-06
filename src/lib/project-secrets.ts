const MASK = "••••";

const TOKEN_FIELDS = ["githubToken", "gitlabToken", "codaToken"] as const;

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
