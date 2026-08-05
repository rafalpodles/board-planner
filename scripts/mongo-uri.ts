/**
 * Railway names the connection differently per service: the app service holds a
 * MONGODB_URI on the private network, which only resolves from inside Railway,
 * while the database service exposes a public address under a different name.
 * These scripts run from a laptop, so they have to find the reachable one.
 */
const URI_VARS = ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"];

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
        `Run against the database service instead, which exposes a public address:\n` +
        `  railway run --service MongoDB -- npx tsx scripts/<script>.ts ...`
    );
  }
  return reachable[0];
}

/**
 * A public database URL usually carries no database in its path, and both the
 * driver and Mongoose then quietly fall back to a default name. That fallback can
 * be the real database, so this cannot be validated by name — callers check content.
 */
export const dbName = () => process.env.MONGODB_DB || undefined;
