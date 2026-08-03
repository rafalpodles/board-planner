/**
 * Railway names the connection string differently per service: the app service gets
 * MONGODB_URI pointing at the private network, the database service gets
 * MONGO_PUBLIC_URL for the outside. Anything on `.railway.internal` only resolves
 * inside Railway, so prefer a candidate we know can actually connect from here.
 */
const URI_VARS = ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"];

export function resolveMongoUri(scriptPath: string): { uri: string; source: string } {
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
        `  railway run --service MongoDB -- sh -c 'MONGODB_URI="$MONGO_PUBLIC_URL" npx tsx ${scriptPath}'`
    );
  }
  return reachable[0];
}

/**
 * A public Railway URL often carries no database in its path, and the driver then
 * quietly hands back `test` — an empty database that reports nothing to do, which
 * is indistinguishable from work already finished.
 */
export function assertDatabaseIsNotEmpty(name: string, projectCount: number): void {
  if (projectCount > 0) return;
  throw new Error(
    `Database "${name}" holds no projects — this is almost certainly the wrong one, ` +
      `not a database with nothing left to do.\n` +
      `Set MONGODB_DB to name the right one, or put it in the connection string's path.`
  );
}
