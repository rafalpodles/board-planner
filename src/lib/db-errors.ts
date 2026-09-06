export class DatabaseUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "the database is unreachable");
    this.name = "DatabaseUnavailableError";
  }
}

const UNREACHABLE_ERRORS = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoClientClosedError",
]);

export function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  if (!(err instanceof Error)) return false;
  if (UNREACHABLE_ERRORS.has(err.name)) return true;
  return err.name === "MongooseError" && /buffering timed out/i.test(err.message);
}
