/**
 * Railway names the connection differently per service, and the ones it injects sit on the
 * private network, which only resolves from inside Railway. These scripts run from a laptop, so
 * they take the first one that does not, which is the tunnel's MONGODB_URI when one is set.
 */
const URI_VARS = ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"];

const TUNNEL_URI =
  "mongodb://$MONGOUSER:$MONGOPASSWORD@127.0.0.1:<port>/?authSource=admin&directConnection=true";

export function resolveUri(): { uri: string; source: string } {
  const found = URI_VARS.filter((name) => process.env[name]).map((name) => ({
    source: name,
    uri: process.env[name] as string,
  }));
  if (!found.length) throw new Error(`Set one of: ${URI_VARS.join(", ")}`);

  const reachable = found.filter((c) => !c.uri.includes(".railway.internal"));
  if (!reachable.length) {
    throw new Error(
      `${found.map((c) => c.source).join(", ")} point at Railway's private network ` +
        `(.railway.internal), which only resolves from inside Railway.\n` +
        `Reach the database through a tunnel instead, in two terminals:\n` +
        `  1. railway connect MongoDB --tunnel-only    (prints the local <port>)\n` +
        `  2. railway run --service MongoDB -- sh -c 'MONGODB_URI="${TUNNEL_URI}" npx tsx scripts/<script>.ts ...'`
    );
  }
  return reachable[0];
}

/**
 * A tunnel or public database URL usually carries no database in its path, and both the
 * driver and Mongoose then quietly fall back to a default name. That fallback can
 * be the real database, so this cannot be validated by name — callers check content.
 */
export const dbName = () => process.env.MONGODB_DB || undefined;
