import type { McpToolDef } from "./mcp-client";

/**
 * A read verb as the first whole token: `get_issue`. Matched as a token rather than a prefix: as a
 * prefix `readjust_budget` and `listen_for_webhooks` counted as reads (BP-476).
 */
const READ_VERBS = new Set(["search", "list", "get", "read", "fetch", "query", "describe", "find"]);
/**
 * The one verb also accepted last, for the noun-first style the official GitHub server uses
 * (`issue_read`, `pull_request_read`). Only this one: any read verb last would let
 * `export_to_search` or `rebuild_list` through, whose first word is the one that acts.
 */
const TRAILING_READ_VERB = "read";
/**
 * Verbs that make a read-prefixed name a mutation. Matched as whole **tokens**, not substrings:
 * as a substring this rejected `get_settings` ("set"), `list_presets` ("reset"),
 * `list_closed_issues` ("close") and `get_merged_pull_requests` ("merge") — all reads, and all
 * with no way for an admin to get them back, because `toolAllowlist` only narrows. Token equality
 * keeps `find_and_merge_duplicates` caught while letting `get_merged_pull_requests` through.
 *
 * `run`, `grant`, `commit`, `push`, `import`, `deploy`, `sync` and `restore` are deliberately absent.
 * Each is a real read's noun as often as a verb (`get_run_status`, `get_grant`, `get_commit`,
 * `list_push_rules`, `get_import_status`, `list_deploy_keys`, `get_sync_status`,
 * `list_restore_points`). Leaving them out means a read-prefixed name that uses one as a verb —
 * `fetch_and_sync_repo` — still passes; the read prefix only turns away names that start with the
 * mutation, like `push_files`. A server that marks such a tool `readOnlyHint: false` still vetoes it.
 */
const WRITE_VERBS = new Set([
  "create", "update", "delete", "write", "append", "replace", "insert", "remove", "set", "patch",
  "post", "send", "move", "archive", "upload", "edit", "destroy", "drop", "purge", "clear",
  "reset", "rename", "assign", "close", "merge", "approve", "revoke", "execute", "invoke", "trigger",
  // BP-476: each of these passed as a read inside a read-prefixed name (`get_or_add_label`)
  "add", "save", "publish", "cancel", "disable", "enable", "upsert", "submit",
  // A read verb at the END reads `mark_all_notifications_read` as a read unless these are known
  "mark", "unpublish", "dismiss", "resolve", "reopen", "lock", "unlock", "star", "unstar",
  "subscribe", "unsubscribe", "acknowledge", "modify",
]);

/**
 * Verbs that only mean a mutation in front of a trailing `read` — `toggle_read`, `flag_as_read`.
 * Anywhere else they are ordinary nouns of real reads: LaunchDarkly's `get-flag`, `get_feature_toggle`.
 */
const WRITE_VERBS_BEFORE_A_TRAILING_READ = new Set(["toggle", "flag", "ack", "put"]);

/**
 * `query` reads only when it names what it queries: `query_prometheus`, `notion-query-data-sources`.
 * Alone, or naming a query language anywhere after it, it runs whatever it is sent — `mysql_query`
 * on a server named `mysql` is arbitrary SQL, and stripping the server's name must not make it a read.
 */
const QUERY_LANGUAGES_NOT_ENDING_IN_QL = new Set(["cypher", "sqlite", "gremlin"]);
/** Languages that end in `ql` and can only read: a tool that queries logs or metrics in one is a read */
const READ_ONLY_QUERY_LANGUAGES = new Set([
  "hogql", "logql", "promql", "traceql", "metricsql", "jql", "soql", "nrql", "kql", "esql",
]);

/**
 * A query language, or a database named after one: every word ending in `ql` (`sql`, `mysql`,
 * `postgresql`, `graphql`, `logql`, `soql`) plus the few that do not. Checked on the whole name,
 * the connection's own name included — `sql_query_tables` on a connection named `sql` is still SQL —
 * word by word and each word run into the next, since `queryGraphQL` tokenises as `graph` + `ql`.
 */
function namesAQueryLanguage(tokens: string[]): boolean {
  const isLanguage = (word: string) =>
    (word.endsWith("ql") && !READ_ONLY_QUERY_LANGUAGES.has(word)) || QUERY_LANGUAGES_NOT_ENDING_IN_QL.has(word);
  return tokens.some((t, i) => isLanguage(t) || (tokens[i + 1] === "ql" && isLanguage(`${t}ql`)));
}

/** `getWorkflowRun` and `get_workflow-run` are the same name to anyone reading it */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Whether this tool may be exposed on a project that has not enabled writes.
 *
 * `readOnlyHint` is supplied by the **remote server**, and this used to return it verbatim — so a
 * server that annotated a mutating tool `readOnlyHint: true` was exposed on a project whose admin
 * had set `allowWrites: false`, and its calls never counted against the per-turn write cap. The
 * hint can now only make a tool *more* restricted, never less: the name decides, and a server may
 * veto its own tool by saying `false`.
 *
 * A server often prefixes its tools with its own name (`notion-search`, `slack_list_channels`), so
 * the tokens of the server's name are taken off the front before the read verb is looked for.
 */
export function isReadSafe(tool: McpToolDef, serverName = ""): boolean {
  const allTokens = tokensOf(tool.name);
  let tokens = allTokens;
  const prefix = tokensOf(serverName);
  if (prefix.length > 0 && prefix.length < tokens.length && prefix.every((t, i) => tokens[i] === t)) {
    tokens = tokens.slice(prefix.length);
  }
  const first = tokens[0];
  const leadingRead =
    READ_VERBS.has(first) && (first !== "query" || (tokens.length > 1 && !namesAQueryLanguage(allTokens)));
  const trailingRead = tokens.length > 1 && tokens[tokens.length - 1] === TRAILING_READ_VERB;
  const readShaped = leadingRead || trailingRead;
  // Every token, the server's name included: a server named `delete` must not lend its tools a pass
  const mutates = allTokens.some(
    (t) => WRITE_VERBS.has(t) || (!leadingRead && WRITE_VERBS_BEFORE_A_TRAILING_READ.has(t))
  );
  return readShaped && !mutates && tool.annotations?.readOnlyHint !== false;
}
