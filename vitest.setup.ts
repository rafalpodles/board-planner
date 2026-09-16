// React needs this flag to accept act(...) from a test runner
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Node 26 defines localStorage on globalThis and reads it as undefined without
// --localstorage-file; vitest's happy-dom environment leaves globals it did not create alone, so
// the DOM's own Storage never lands. sessionStorage needs no such repair — Node's is in-memory
if (typeof document !== "undefined" && !globalThis.localStorage) {
  const { Storage } = await import("happy-dom");
  Object.defineProperty(globalThis, "localStorage", {
    value: new Storage(),
    configurable: true,
    writable: true,
  });
}

// A unit suite must not resolve real names. safeFetch looks every public host up before fetching,
// so 435 lookups of api.github.com went to the real resolver — and under the full run a slow one
// timed whole files out. Patched on the shared module object and resynced, because vi.mock on a
// builtin that safeFetch imports lazily still let about half of those calls through.
{
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const { isIP } = await import("node:net");
  const dns = createRequire(import.meta.url)("node:dns/promises");
  const real = dns.lookup;
  const answer = { address: "140.82.112.6", family: 4 };
  dns.lookup = (host: string, options?: { all?: boolean }, ...rest: unknown[]) =>
    host === "localhost" || isIP(host)
      ? real.call(dns, host, options, ...rest)
      : Promise.resolve(options?.all ? [answer] : answer);
  syncBuiltinESMExports();
}

export {};
