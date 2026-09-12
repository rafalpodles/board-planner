import { decryptSecret } from "./encryption";

const MASK = "••••";

/**
 * Which rows have already been reported this process, by id. `sanitizeProjectSecrets` runs on every read
 * of a project — the board polls one every 10 seconds per open tab, and the sidebar maps it over
 * the whole list — so an unconditional log for a key that will never come back is not a signal,
 * it is a bill. A restart reports it again, which is what makes a problem that is still there
 * visible again.
 */
const reportedUnreadable = new Set<string>();

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
 * A channel's URL is stored encrypted, and an `enc:v2:…` envelope is a parseable URL with a
 * non-special scheme — so masking the stored string would print `null/••••` plus a tail of
 * ciphertext instead of the host the owner needs to recognise the channel by.
 */
function maskStoredUrl(
  value: string | undefined,
  row: string,
  project: string,
  channel: string
): string {
  if (!value) return "";
  try {
    return maskSecretUrl(decryptSecret(value));
  } catch {
    // The bare mask is also what an unparseable URL gets, so on screen the two are one state.
    // A rotation that lost the old key is otherwise silent in both directions: the channel stops
    // delivering and the row it happened to just reads as dots.
    if (!reportedUnreadable.has(row)) {
      reportedUnreadable.add(row);
      console.error(
        `Project chat webhook could not be decrypted: project ${project}, channel "${channel}"`
      );
    }
    return MASK;
  }
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
    const projectLabel = String(obj.key || obj._id || "unknown");
    obj.notificationChannels = obj.notificationChannels.map((channel, index) => {
      const { webhookUrl, ...rest } = channel as Record<string, unknown>;
      return {
        ...rest,
        webhookUrlMasked: maskStoredUrl(
          webhookUrl as string | undefined,
          // Keyed on ids, never on names: a rename is a new key, so the same broken row would
          // report itself again on every rename — and renaming is exactly what an owner does
          // while trying to fix it.
          `${obj._id ?? projectLabel}/${rest._id ?? rest.name ?? index}`,
          projectLabel,
          String(rest.name ?? "")
        ),
      };
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
