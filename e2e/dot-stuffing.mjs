/**
 * Undoes the dot-stuffing RFC 5321 §4.5.2 requires of the client: a body line beginning with a dot
 * is sent doubled so it cannot be mistaken for the terminator, and a reader that keeps both sees a
 * body its sender never wrote. The specs match on a task title, so a title starting with a dot
 * would silently stop matching.
 *
 * Its own module rather than an export from `smtp-stub.mjs`, because `e2e/*.test.ts` runs under
 * `npm test` and importing the stub executes its module body: `openssl` for a certificate, two
 * listening sockets, and a process-wide `uncaughtException` handler, all inside a vitest worker.
 */
export function unstuff(body) {
  return body.replace(/^\.\./gm, ".");
}
