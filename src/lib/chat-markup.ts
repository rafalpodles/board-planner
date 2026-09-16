/**
 * Slack reads `<url|text>` as a link, so a `>` anywhere inside closes it and whatever follows can
 * open a second link the reader has no reason to distrust. Escaping the three characters Slack
 * treats as markup is the documented fix. Every interpolated value needs it, the URL half included:
 * a project key is part of it and is not constrained to a format.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Discord has no link syntax in `content`, but markdown forges a headline and `@everyone` pings the
 * room. The markup characters are escaped here; the mentions are refused at the API with
 * `DISCORD_NO_MENTIONS`, which is what `allowed_mentions` is for.
 */
export function escapeDiscord(text: string): string {
  return text.replace(/([*_~`|\\>\[\]()#])/g, "\\$1");
}

export const DISCORD_NO_MENTIONS = { parse: [] as string[] };

/** Cut before escaping, so the cut never lands inside an entity or after a lone backslash */
export function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}...` : text;
}
